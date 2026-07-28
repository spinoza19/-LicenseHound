/**
 * Recover a decision from the transaction record.
 *
 * Bradbury's public RPC currently serves writes but not GenVM state reads (its
 * GenVM index sits ~400k blocks behind the chain head), so `gen_call` answers
 * "contract not found" for every contract on the network. The decision is still
 * fully recoverable: it is inside the transaction the validators agreed on.
 */
const hash = process.argv[2];
const EXPLORER = "https://explorer-bradbury.genlayer.com/api/v1";

const res = await fetch(`${EXPLORER}/transactions/${hash}`, {
  headers: { "User-Agent": "licensehound" },
});
if (!res.ok) {
  console.error(`explorer ${res.status}`);
  process.exit(1);
}
const tx = await res.json();

console.log("status          :", tx.status);
console.log("execution       :", tx.execution_result);

const round = tx.consensus_history?.consensus_results?.at(-1) ?? tx.consensus_history?.rounds?.at(-1);
const votes = {};
const walk = (node) => {
  if (!node || typeof node !== "object") return;
  if (node.vote) votes[node.vote] = (votes[node.vote] ?? 0) + 1;
  for (const v of Object.values(node)) walk(v);
};
walk(tx);
console.log("validator votes :", JSON.stringify(votes));
void round;

// The leader's equivalence outputs carry the model's answer verbatim.
const raw = JSON.stringify(tx);
const found = raw.match(/\{\\"derivative\\":[^}]*\}|\{"derivative":[^}]*\}/);
if (found) {
  console.log("model answer    :", found[0].replace(/\\"/g, '"'));
} else {
  const eq = raw.match(/"eq_outputs":\s*\[[^\]]*\]/);
  if (eq) console.log("eq_outputs      :", eq[0].slice(0, 1500));
}
