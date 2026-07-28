/**
 * Reading LicenseHound without a read endpoint.
 *
 * Bradbury's public RPC currently serves writes but not GenVM state reads — its
 * GenVM index sits several hundred thousand blocks behind the chain head, so
 * `gen_call` answers "contract not found" for every contract on the network,
 * not just this one. Waiting for that to catch up is not a plan, so the app
 * reconstructs its own view instead:
 *
 *   1. list the contract's transactions from the explorer index,
 *   2. decode each one's calldata to recover the exact arguments that were
 *      submitted (watch definitions, claims, adjudication requests),
 *   3. for a settled claim, take the ONE non-deterministic value the network
 *      actually voted on — the model's `derivative` boolean — out of the
 *      consensus record,
 *   4. recompute every deterministic input locally (similarity, licence match)
 *      and derive the verdict with the same rules the contract uses.
 *
 * Step 4 is safe precisely because those parts are deterministic by
 * construction: recomputing them here must produce the same numbers the
 * validators produced, or the contract's own equivalence principle would have
 * failed. Nothing subjective is invented client-side.
 */
import { decodeInputData } from "genlayer-js";
import { CONTRACT_ADDRESS } from "./genlayer";
import { fetchRaw, jaccardBp, normalize } from "./github";

// The explorer API sends no CORS headers, so in dev it is reached through the
// Vite proxy declared in vite.config.ts.
const EXPLORER_API = import.meta.env.DEV
  ? "/explorer/api/v1"
  : "https://explorer-bradbury.genlayer.com/api/v1";

const LICENSE_CANDIDATES = [
  "LICENSE",
  "LICENSE.txt",
  "LICENSE.md",
  "COPYING",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
];

/** Kept in lockstep with the contract's constants. */
export const MIN_JACCARD_BP = 1500;
export const LICENSE_MATCH_BP = 6000;

export type Verdict =
  | "PENDING"
  | "VIOLATION"
  | "COMPLIANT"
  | "UNRELATED"
  | "INCONCLUSIVE";

export type Pair = { origin: string; suspect: string };

export type Watch = {
  watchId: string;
  originRepo: string;
  originSha: string;
  licenseId: string;
  bountyAtto: bigint;
  owner: string;
  open: boolean;
  txHash: string;
  at: number;
};

export type Claim = {
  claimId: number;
  watchId: string;
  suspectRepo: string;
  suspectSha: string;
  pairs: Pair[];
  bondAtto: bigint;
  reporter: string;
  txHash: string;
  at: number;
  verdict: Verdict;
  judgeTx?: string;
  derivative?: boolean;
  reasoning?: string;
};

export type Ledger = { watches: Watch[]; claims: Claim[] };

type RawTx = {
  hash: string;
  from_address: string;
  status: string;
  execution_result: string;
  submission_timestamp: number;
  value: string;
  data?: { params?: { _calldata?: string } };
};

async function fetchTransactions(): Promise<RawTx[]> {
  const out: RawTx[] = [];
  for (let page = 1; page <= 5; page++) {
    const url =
      `${EXPLORER_API}/transactions?address=${CONTRACT_ADDRESS}` +
      `&response_type=transactions&page=${page}&page_size=50`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`explorer ${res.status}`);
    const body = await res.json();
    const batch: RawTx[] = body.transactions ?? [];
    out.push(...batch);
    if (out.length >= (body.total ?? out.length) || batch.length === 0) break;
  }
  return out.sort((a, b) => a.submission_timestamp - b.submission_timestamp);
}

function decodeCall(tx: RawTx): { method: string; args: any[] } | null {
  const raw = tx.data?.params?._calldata;
  if (!raw) return null;
  try {
    const decoded: any = decodeInputData(
      ("0x" + raw.replace(/^0x/, "")) as `0x${string}`,
      CONTRACT_ADDRESS,
    );
    // calldata decodes into Maps, not plain objects
    const call = decoded?.callData;
    const method = call instanceof Map ? call.get("method") : call?.method;
    const args = call instanceof Map ? call.get("args") : call?.args;
    if (!method) return null;
    return { method: String(method), args: (args ?? []).map(String) };
  } catch {
    return null;
  }
}

/** The model's answer, lifted straight out of the consensus record. */
function extractDerivative(txJson: string): { derivative: boolean; reasoning: string } | null {
  const match = txJson.match(/\{\\?"derivative\\?":\s*(true|false)[^}]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0].replace(/\\"/g, '"'));
    return {
      derivative: Boolean(parsed.derivative),
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch {
    return { derivative: match[1] === "true", reasoning: "" };
  }
}

async function fetchJudgement(hash: string) {
  const res = await fetch(`${EXPLORER_API}/transactions/${hash}`);
  if (!res.ok) return null;
  return extractDerivative(JSON.stringify(await res.json()));
}

export async function loadLedger(): Promise<Ledger> {
  const txs = await fetchTransactions();
  const watches: Watch[] = [];
  const claims: Claim[] = [];
  const judged = new Map<number, { hash: string }>();
  let nextClaimId = 0;

  for (const tx of txs) {
    if (tx.execution_result !== "FINISHED_WITH_RETURN") continue;
    const call = decodeCall(tx);
    if (!call) continue;

    if (call.method === "open_watch") {
      const [watchId, originRepo, originSha, licenseId] = call.args;
      watches.push({
        watchId,
        originRepo,
        originSha,
        licenseId,
        bountyAtto: BigInt(tx.value || "0"),
        owner: tx.from_address,
        open: true,
        txHash: tx.hash,
        at: tx.submission_timestamp,
      });
    } else if (call.method === "top_up") {
      const watch = watches.find((w) => w.watchId === call.args[0]);
      if (watch) watch.bountyAtto += BigInt(tx.value || "0");
    } else if (call.method === "file_claim") {
      const [watchId, suspectRepo, suspectSha, pairsJson] = call.args;
      let pairs: Pair[] = [];
      try {
        pairs = JSON.parse(pairsJson);
      } catch {
        /* the contract already rejected malformed input */
      }
      claims.push({
        claimId: nextClaimId++,
        watchId,
        suspectRepo,
        suspectSha,
        pairs,
        bondAtto: BigInt(tx.value || "0"),
        reporter: tx.from_address,
        txHash: tx.hash,
        at: tx.submission_timestamp,
        verdict: "PENDING",
      });
    } else if (call.method === "adjudicate") {
      judged.set(Number(call.args[0]), { hash: tx.hash });
    } else if (call.method === "close_watch") {
      const watch = watches.find((w) => w.watchId === call.args[0]);
      if (watch) watch.open = false;
    }
  }

  // Attach the consensus decision to each judged claim.
  await Promise.all(
    [...judged.entries()].map(async ([claimId, { hash }]) => {
      const claim = claims.find((c) => c.claimId === claimId);
      if (!claim) return;
      claim.judgeTx = hash;
      const judgement = await fetchJudgement(hash);
      if (!judgement) return;
      claim.derivative = judgement.derivative;
      claim.reasoning = judgement.reasoning;
    }),
  );

  return { watches, claims };
}

/**
 * A claim's verdict, in the same order the contract derives it. Before the
 * local measurements arrive the answer is genuinely unknown, so it stays
 * PENDING rather than guessing.
 */
export function verdictOf(claim: Claim, m?: Measurements): Verdict {
  if (!claim.judgeTx || claim.derivative === undefined) return "PENDING";
  if (!m) return "PENDING";
  return deriveVerdict(claim.derivative, m).verdict;
}

export type Measurements = {
  similarityBp: number;
  anyIdentical: boolean;
  licenseMatchBp: number;
  attributionPresent: boolean;
  perPair: { origin: string; suspect: string; bp: number; identical: boolean }[];
};

async function bestLicense(repo: string, sha: string): Promise<string> {
  for (const name of LICENSE_CANDIDATES) {
    const text = await fetchRaw(repo, sha, name).catch(() => null);
    if (text && text.trim().length > 200) return normalize(text).toLowerCase();
  }
  return "";
}

/**
 * Re-run the contract's deterministic stages in the browser. These must match
 * the on-chain numbers; if they ever drift, the equivalence principle would
 * have rejected the transaction in the first place.
 */
export async function measure(
  origin: { repo: string; sha: string },
  suspect: { repo: string; sha: string },
  pairs: Pair[],
): Promise<Measurements> {
  const perPair = await Promise.all(
    pairs.map(async (pair) => {
      const [left, right] = await Promise.all([
        fetchRaw(origin.repo, origin.sha, pair.origin),
        fetchRaw(suspect.repo, suspect.sha, pair.suspect),
      ]);
      const a = normalize(left ?? "");
      const b = normalize(right ?? "");
      return {
        origin: pair.origin,
        suspect: pair.suspect,
        bp: jaccardBp(a, b),
        identical: a === b && a.length > 0,
      };
    }),
  );

  const [originLicense, suspectLicense] = await Promise.all([
    bestLicense(origin.repo, origin.sha),
    bestLicense(suspect.repo, suspect.sha),
  ]);
  const licenseMatchBp =
    originLicense && suspectLicense ? jaccardBp(originLicense, suspectLicense) : 0;

  return {
    similarityBp: perPair.reduce((max, p) => Math.max(max, p.bp), 0),
    anyIdentical: perPair.some((p) => p.identical),
    licenseMatchBp,
    attributionPresent: licenseMatchBp >= LICENSE_MATCH_BP,
    perPair,
  };
}

/** The contract's Stage 4, mirrored exactly. */
export function deriveVerdict(
  derivative: boolean,
  m: Measurements,
): { verdict: Verdict; veto?: string } {
  if (!derivative) {
    if (m.anyIdentical)
      return { verdict: "INCONCLUSIVE", veto: "a file pair is byte-identical" };
    return { verdict: "UNRELATED" };
  }
  if (m.attributionPresent) return { verdict: "COMPLIANT" };
  if (m.similarityBp < MIN_JACCARD_BP && !m.anyIdentical)
    return { verdict: "INCONCLUSIVE", veto: "measured similarity below threshold" };
  return { verdict: "VIOLATION" };
}
