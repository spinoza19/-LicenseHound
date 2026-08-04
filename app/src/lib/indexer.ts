/**
 * Reading LicenseHound.
 *
 * The contract is the authority. `stats()` gives the exact number of claims
 * ever filed, and `get_receipt(id)` answers for each one by its real id, so the
 * ledger is enumerated from the contract's own counter rather than from
 * whatever slice of history an index happened to return. There is no window: if
 * the contract says there are 900 claims, this reads 900 receipts.
 *
 * An earlier version did the opposite — it scanned the explorer's transaction
 * list, decoded calldata, and *derived* each verdict client-side. Bradbury's
 * RPC used to answer "contract not found" for every `gen_call` on the network,
 * so there was nothing else to read. That reconstruction was wrong in three
 * ways, all of which follow from deriving state instead of reading it:
 *
 *   - it scanned five pages and stopped, so older claims silently vanished;
 *   - it numbered claims by scan order, so an id could refer to a different
 *     claim than the contract meant by it;
 *   - it inferred a verdict from the model's `derivative` boolean, which does
 *     not exist for a claim the contract settled without asking a model. An
 *     UNSUBSTANTIATED claim has no such boolean, so it showed as pending
 *     forever.
 *
 * Reads work now, so none of that is reconstructed any more. The explorer is
 * still consulted, but only to decorate settled state with transaction hashes
 * and timestamps for links — it can fail entirely and the ledger is unaffected.
 */
import { CONTRACT_ADDRESS, makeClient } from "./genlayer";
import { fetchRaw, jaccardBp, normalize } from "./github";

// The explorer API answers fine but sends no Access-Control-Allow-Origin, so a
// browser refuses to hand us the response. It is always reached through a
// same-origin proxy: vite.config.ts in dev, the rewrite in vercel.json in
// production. Calling the explorer host directly works nowhere except curl.
const EXPLORER_API = "/explorer/api/v1";

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
  | "INCONCLUSIVE"
  | "UNSUBSTANTIATED";

export type Pair = { origin: string; suspect: string };

export type Watch = {
  watchId: string;
  originRepo: string;
  originSha: string;
  licenseId: string;
  bountyAtto: bigint;
  owner: string;
  open: boolean;
  openClaims: number;
  claimIds: number[];
  txHash?: string;
  at?: number;
};

export type Claim = {
  /** The contract's own id. Never a position in a list. */
  claimId: number;
  watchId: string;
  suspectRepo: string;
  suspectSha: string;
  pairs: Pair[];
  bondAtto: bigint;
  reporter: string;
  /** Authoritative: what the contract stored when it settled. */
  verdict: Verdict;
  settled: boolean;
  similarityBp: number;
  derivative: boolean;
  attributionPresent: boolean;
  reasoning: string;
  txHash?: string;
  judgeTx?: string;
  at?: number;
};

export type Ledger = { watches: Watch[]; claims: Claim[] };

const VERDICTS = new Set<Verdict>([
  "PENDING",
  "VIOLATION",
  "COMPLIANT",
  "UNRELATED",
  "INCONCLUSIVE",
  "UNSUBSTANTIATED",
]);

const asVerdict = (value: unknown): Verdict =>
  VERDICTS.has(String(value) as Verdict) ? (String(value) as Verdict) : "PENDING";

// ---------------------------------------------------------------------------
// Authoritative reads
// ---------------------------------------------------------------------------
function reader() {
  const client = makeClient();
  return (functionName: string, args: any[] = []) =>
    client.readContract({
      address: CONTRACT_ADDRESS,
      functionName,
      args,
      jsonSafeReturn: true,
    }) as Promise<any>;
}

/** Bound concurrency so a large docket does not open 900 sockets at once. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = cursor++; i < items.length; i = cursor++) out[i] = await fn(items[i]);
  });
  await Promise.all(workers);
  return out;
}

export async function loadLedger(): Promise<Ledger> {
  const read = reader();

  const [stats, listed] = await Promise.all([read("stats"), read("list_watches")]);

  // Every watch, with its owner and the claim ids the contract associates with
  // it — not an ordering this file invented.
  const watches: Watch[] = await mapLimit(listed ?? [], 6, async (row: any) => {
    const full = await read("get_watch", [row.watch_id]);
    return {
      watchId: String(row.watch_id),
      originRepo: String(row.origin_repo),
      originSha: String(row.origin_sha),
      licenseId: String(row.license_id),
      bountyAtto: BigInt(row.bounty ?? "0"),
      owner: String(full?.owner ?? ""),
      open: Boolean(row.open),
      openClaims: Number(row.open_claims ?? 0),
      claimIds: (full?.claims ?? []).map((id: any) => Number(id)),
    };
  });

  // `stats.claims` is the contract's next_claim_id: every id ever issued.
  const total = Number(stats?.claims ?? 0);
  const ids = Array.from({ length: total }, (_, i) => i);
  const receipts = await mapLimit(ids, 8, (id) =>
    read("get_receipt", [BigInt(id)]).catch(() => null),
  );

  const claims: Claim[] = [];
  receipts.forEach((receipt, id) => {
    if (!receipt) return;
    claims.push({
      claimId: Number(receipt.claim_id ?? id),
      watchId: String(receipt.watch_id ?? ""),
      suspectRepo: String(receipt.suspect?.repo ?? ""),
      suspectSha: String(receipt.suspect?.sha ?? ""),
      pairs: (receipt.pairs ?? []) as Pair[],
      bondAtto: BigInt(receipt.bond ?? "0"),
      reporter: String(receipt.reporter ?? ""),
      verdict: asVerdict(receipt.verdict),
      settled: Boolean(receipt.settled),
      similarityBp: Number(receipt.similarity_bp ?? 0),
      derivative: Boolean(receipt.derivative),
      attributionPresent: Boolean(receipt.attribution_present),
      reasoning: String(receipt.reasoning ?? ""),
    });
  });

  await decorateWithTransactions(watches, claims);
  return { watches, claims };
}

/**
 * Best-effort only. Transaction hashes and timestamps make the receipt
 * linkable; they are not state, so every failure here is swallowed. Nothing
 * displayed as fact depends on this succeeding.
 */
async function decorateWithTransactions(watches: Watch[], claims: Claim[]) {
  try {
    const res = await fetch(
      `${EXPLORER_API}/transactions?address=${CONTRACT_ADDRESS}` +
        `&response_type=transactions&page=1&page_size=50`,
    );
    if (!res.ok) return;
    const body = await res.json();
    const txs: any[] = body.transactions ?? [];

    for (const tx of txs) {
      const raw = JSON.stringify(tx);
      for (const watch of watches) {
        if (!watch.txHash && raw.includes(`"${watch.watchId}"`)) {
          watch.txHash = tx.hash;
          watch.at = tx.submission_timestamp;
        }
      }
      for (const claim of claims) {
        if (!claim.txHash && raw.includes(claim.suspectSha)) {
          claim.txHash = tx.hash;
          claim.at = tx.submission_timestamp;
        }
      }
    }
  } catch {
    /* links are a nicety; the ledger already stands on its own */
  }
}

// ---------------------------------------------------------------------------
// Independent verification
// ---------------------------------------------------------------------------
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
 * Re-run the contract's deterministic stages in the browser.
 *
 * This is a check, never a source. The verdict shown to the user is the one the
 * contract stored; this exists so a reader can confirm the numbers behind it
 * without trusting either the contract or this page — the inputs are pinned to
 * immutable commits, so the arithmetic must land on the same answer.
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

/** The contract's Stage 4, mirrored — used only to check its answer. */
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

/**
 * Does the browser's own arithmetic agree with what the contract stored?
 *
 * Only meaningful for verdicts that came from the deterministic pipeline. An
 * UNSUBSTANTIATED claim was settled without measuring anything, so there is
 * nothing to re-derive and nothing to disagree about.
 */
export function checkAgainstContract(
  claim: Claim,
  m?: Measurements,
): { checked: boolean; agrees: boolean } {
  if (!m || !claim.settled || claim.verdict === "UNSUBSTANTIATED")
    return { checked: false, agrees: true };
  return { checked: true, agrees: deriveVerdict(claim.derivative, m).verdict === claim.verdict };
}
