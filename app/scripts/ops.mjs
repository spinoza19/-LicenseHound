/**
 * LicenseHound operator script.
 *
 * The CLI's `genlayer write` cannot attach value, and every money-moving method
 * here is payable, so scripted operations go through genlayer-js directly.
 *
 *   node scripts/ops.mjs stats
 *   node scripts/ops.mjs watches
 *   node scripts/ops.mjs open-watch <id> <owner/repo> <sha> <license> <gen>
 *   node scripts/ops.mjs claim <watchId> <owner/repo> <sha> <pairsJson> <gen>
 *   node scripts/ops.mjs judge <claimId>
 *   node scripts/ops.mjs receipt <claimId>
 *   node scripts/ops.mjs withdraw
 *
 * Reads GENLAYER_PRIVATE_KEY and VITE_CONTRACT_ADDRESS from ../.env / .env.local
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv(...paths) {
  const env = {};
  for (const p of paths) {
    try {
      for (const line of readFileSync(resolve(here, p), "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
        if (m && !line.trim().startsWith("#")) env[m[1]] = m[2];
      }
    } catch {
      /* optional */
    }
  }
  return env;
}

const env = loadEnv("../../.env", "../.env.local");
// `AS=hunter` switches identity — a watch owner cannot file a claim on their
// own watch, so the demo needs two.
const PK =
  process.env.AS === "hunter"
    ? (process.env.HUNTER_PRIVATE_KEY ?? env.HUNTER_PRIVATE_KEY)
    : (process.env.GENLAYER_PRIVATE_KEY ?? env.GENLAYER_PRIVATE_KEY);
const ADDRESS = process.env.VITE_CONTRACT_ADDRESS ?? env.VITE_CONTRACT_ADDRESS;

if (!ADDRESS) throw new Error("VITE_CONTRACT_ADDRESS missing (app/.env.local)");

const account = PK ? createAccount(PK) : undefined;
const client = createClient({ chain: testnetBradbury, account });

const GEN = 10n ** 18n;
const gen = (s) => {
  const [w, f = ""] = String(s).split(".");
  return BigInt(w) * GEN + BigInt(f.padEnd(18, "0").slice(0, 18));
};

const jsonify = (v) =>
  JSON.stringify(
    v,
    (_, x) =>
      x instanceof Map ? Object.fromEntries(x) : typeof x === "bigint" ? x.toString() : x,
    2,
  );

const read = (functionName, args = []) =>
  client.readContract({ address: ADDRESS, functionName, args, jsonSafeReturn: true });

async function write(functionName, args = [], value = 0n) {
  const hash = await client.writeContract({ address: ADDRESS, functionName, args, value });
  console.log(`tx ${hash}`);
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: "ACCEPTED",
    interval: 4000,
    retries: 120,
  });
  console.log(
    `  status=${receipt.status_name ?? receipt.status} ` +
      `result=${receipt.resultName ?? ""} exec=${receipt.txExecutionResultName ?? ""}`,
  );
  const leader = receipt.consensus_data?.leader_receipt?.[0];
  if (leader?.execution_result) console.log(`  execution=${leader.execution_result}`);
  if (leader?.genvm_result?.stderr) console.log(`  stderr=${leader.genvm_result.stderr}`);
  return receipt;
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "raw": {
    const receipt = await client.getTransaction({ hash: rest[0] });
    console.log(jsonify(receipt).slice(0, 12000));
    break;
  }

  case "stats":
    console.log(jsonify(await read("stats")));
    break;

  case "watches":
    console.log(jsonify(await read("list_watches")));
    break;

  case "watch":
    console.log(jsonify(await read("get_watch", [rest[0]])));
    break;

  case "open-watch": {
    const [id, repo, sha, license, amount] = rest;
    await write("open_watch", [id, repo, sha, license], gen(amount ?? "0.5"));
    break;
  }

  case "claim": {
    // pairs are given as repeated "originPath::suspectPath" tokens so the
    // JSON never has to survive a shell's quoting rules
    const [watchId, repo, sha, amount, ...pairTokens] = rest;
    const pairs = pairTokens.map((token) => {
      const [origin, suspect] = token.split("::");
      if (!origin || !suspect) throw new Error(`bad pair "${token}"`);
      return { origin, suspect };
    });
    await write(
      "file_claim",
      [watchId, repo, sha, JSON.stringify(pairs)],
      gen(amount ?? "0.2"),
    );
    console.log(`  pairs: ${JSON.stringify(pairs)}`);
    break;
  }

  case "judge":
    await write("adjudicate", [BigInt(rest[0])]);
    console.log(jsonify(await read("get_receipt", [BigInt(rest[0])])));
    break;

  case "receipt":
    console.log(jsonify(await read("get_receipt", [BigInt(rest[0])])));
    break;

  case "pending":
    console.log(await read("get_pending", [rest[0] ?? account.address]));
    break;

  case "withdraw":
    await write("withdraw", []);
    break;

  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
}
