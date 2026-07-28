/** Decode a transaction's GenVM return data / error. */
import { abi } from "genlayer-js";

const hash = process.argv[2];
const RPC = "https://rpc-bradbury.genlayer.com";

const res = await fetch(RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "gen_dbg_traceTransaction",
    params: [{ txID: hash, round: 0 }],
  }),
});
const json = await res.json();
if (json.error) {
  console.log("RPC error:", JSON.stringify(json.error));
  process.exit(1);
}
const r = json.result ?? {};
console.log("result_code:", r.result_code);
console.log("stdout:", r.stdout);
console.log("stderr:", r.stderr);

if (r.return_data) {
  const bytes = Uint8Array.from(
    r.return_data.slice(2).match(/../g).map((h) => parseInt(h, 16)),
  );
  // The payload is a calldata-encoded map; find the human-readable tail.
  const text = new TextDecoder().decode(bytes);
  const marks = ["[EXPECTED]", "[EXTERNAL]", "[TRANSIENT]", "[LLM_ERROR]"];
  for (const m of marks) {
    const i = text.indexOf(m);
    if (i >= 0) console.log("error:", text.slice(i, i + 220));
  }
  try {
    console.log("decoded:", JSON.stringify(abi.calldata.decode(bytes)).slice(0, 900));
  } catch {
    console.log("raw tail:", text.slice(-400).replace(/[^\x20-\x7e]/g, "."));
  }
}
