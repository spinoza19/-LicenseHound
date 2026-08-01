# LicenseHound

A bounty court for open-source licence compliance, running on GenLayer Testnet Bradbury.

A maintainer funds a **watch** on a repository they own. A hunter posts a bond and files a
**claim**: "this other project shipped your code without preserving your licence." The
contract then fetches both code bases itself, measures how much they overlap, checks
whether the licence was preserved, and asks the validator network the single question
arithmetic cannot answer — *is this a derivative work?* The escrow settles on the answer,
and the result is written down as a permanent **Evidence Receipt**.

**Live on Bradbury:** [`0x1902d0bFA468eFBF2efF581207D23FAd11624cfD`](https://explorer-bradbury.genlayer.com/address/0x1902d0bFA468eFBF2efF581207D23FAd11624cfD)

---

## Why this needs GenLayer

Everything about a licence violation is checkable except the part that matters. Whether two
files overlap is arithmetic. Whether a licence file was shipped is string comparison. But
*"is this a derivative work, or do these two files just both call the same API"* is a
judgment — and a judgment that only counts if the accused party cannot dismiss it as one
biased person's opinion.

That is what the network is for. Five validators answer the question independently and the
transaction settles only if their answers agree. Nobody has to trust the maintainer, the
hunter, or whoever ran the model.

## The design decision that makes it work

The first version asked the model for four things at once — verdict, derivative,
attribution, and the list of infringing files — and pasted every code excerpt into the
prompt twice. On Bradbury that produced:

```
status=UNDETERMINED  result=NO_MAJORITY
votes: 1 finished_with_return, 2 nondet_disagree, 2 timeout
```

Two validators timed out on the oversized prompt and two disagreed on a four-field exact
match. So the design changed: **push determinism as far up as it will go, and leave the
model exactly one boolean.**

| Stage | Question | Answered by | Equivalence principle |
|---|---|---|---|
| 1 | What is in these two files? | `gl.nondet.web.get` at a pinned commit SHA | `strict_eq` |
| 2 | How much do they overlap? | integer Jaccard over 5-token shingles | `strict_eq` |
| 3 | Was the licence preserved? | the suspect's licence text vs the original's | `strict_eq` |
| 4 | Is this a derivative work? | **the model — one boolean** | `prompt_comparative` |
| 5 | What is the verdict, who gets paid? | derivation + vetoes, in code | deterministic |

Re-run on Bradbury with that shape:

| Case | Measured | Model | Verdict |
|---|---|---|---|
| `yt-dlp/yt-dlp` vs `ytdl-org/youtube-dl`, `jsinterp.py` | 20.66% overlap, licence preserved | derivative | **COMPLIANT** |
| `psf/requests` vs `ytdl-org/youtube-dl` | ~0% overlap | not derivative | **UNRELATED** — the hunter loses half the bond |

The validators' own reasoning on the first one, stored in the receipt:

> The suspect code contains a direct copy of the function name `function_with_repr` imported
> from utils, replicates the `_js_bit_op` function with the same purpose and similar internal
> logic, and uses the same unique sentinel class `JS_Undefined`, indicating adaptation rather
> than independent implementation.

That is the shape the contract is for: yes it was copied, and no that is not a violation,
because the licence came with it. The second case is the other half — the contract refused
to rubber-stamp an accusation and charged the accuser for making it.

### Pinning to a commit SHA

Every fetch goes to `raw.githubusercontent.com/{repo}/{40-hex-sha}/{path}`, never a branch.
A branch is mutable, so two validators fetching it seconds apart can read different bytes
and consensus dies. Content addressed by SHA is immutable, which is what turns "fetch the
evidence" into a reproducible read that `strict_eq` can wrap. The contract rejects anything
that is not a full 40-character SHA; resolving `owner/repo@main` into one is the frontend's
job.

### Deterministic vetoes

A model that says "derivative" about two files sharing 3% of their tokens must not be able
to move money. After the vote, the contract overrides:

- `VIOLATION` + similarity below 15% + nothing byte-identical → `INCONCLUSIVE`
- `UNRELATED` + a byte-identical file pair → `INCONCLUSIVE`

### Escrow safety

A bounty is a promise to a hunter who has already spent a bond, so the contract holds the
owner to it.

**A funded watch cannot be closed while a claim is pending.** Without that guard the owner
can watch a damaging claim arrive and call `close_watch` before anyone adjudicates it,
walking off with the bounty and leaving the hunter with a spent bond and a verdict that
pays nothing. `Watch.open_claims` counts claims filed but not yet judged, and `close_watch`
refuses while it is non-zero. This delays the owner, it does not trap them: `adjudicate` is
permissionless, so an owner who wants out can resolve the claim themselves and close once
it settles. What they cannot do is skip the judgment.

**Several claims on one watch settle first-past-the-post.** The first `VIOLATION` takes the
whole bounty and closes the watch. Claims already in flight are still adjudicated — the
Evidence Receipt is worth having on its own — but they find an empty pool and are made
whole with their bond instead. A hunter is never punished for the pool being gone by the
time their claim was judged. New claims against a closed watch are rejected outright.

**A claim that cites files which do not exist settles rather than reverting.** Guarding
`close_watch` on a pending-claim count creates a hostage problem the moment any claim can
fail to settle. The first version raised `[EXTERNAL] 404` when a cited file was missing, so
a claim pinned to a plausible-looking but nonexistent SHA reverted every time it was
adjudicated — `open_claims` never dropped and the bounty was frozen forever, for the price
of one bond. But a 404 is not a failure: every validator fetches the same URL and every
validator gets the same answer, which makes "the file is not there" reproducible evidence.
It now yields an `UNSUBSTANTIATED` verdict without consulting a model at all, charged like
any other junk claim, and the watch is free again.

Every branch preserves one invariant: **each atto that enters the contract is either a live
bounty, a bond still in flight, credited to somebody who can withdraw it, or deliberately
burned.** Nothing may be left owned by a closed watch, because a closed watch can never pay
out — so the junk-claim penalty that normally tops up the pool goes to the owner once the
pool is gone. Every exit from `adjudicate` runs through one `_settle` method, so the rules
cannot drift apart between paths. `tests/direct/` asserts this arithmetic end to end,
including the closure attempt, the bounty-draining violation, the later claims that follow
it, and the bogus citation that used to hold a bounty hostage.

## Architecture boundary

| | owns |
|---|---|
| **Frontend** | UI, branch→SHA resolution, non-authoritative similarity previews, indexing |
| **Contract** | escrow, evidence acquisition, the judgment, settlement, the receipt |
| **GitHub** | raw facts, trusted by nobody — every validator re-fetches independently |
| **Wallet** | keys and signatures — the page never sees either |

## Wallet

The app holds no private key and offers no way to paste one in. Wallets are
discovered over **EIP-6963**, so each installed extension announces itself and the user
picks the one they mean — rather than the app assuming `window.ethereum` is the right
wallet, which stops being true the moment two extensions are installed. A pre-6963 wallet
still shows up through the `window.ethereum` fallback.

The GenLayer client is built with an **address**, never an account object:

```ts
createClient({ chain: testnetBradbury, account: address, provider })
```

genlayer-js sees a non-object account and routes `eth_sendTransaction` to the provider, so
every signature happens inside the wallet. No GenLayer MetaMask Snap is required — a
LicenseHound transaction is an ordinary EVM call to the consensus contract.

The adapter also handles what wallets actually do in practice: it switches to chain 4221
(adding it via `wallet_addEthereumChain` if the wallet has never seen it), warns in a
banner when the wallet drifts to another network, follows `accountsChanged` and
`chainChanged`, and silently resumes the last-used wallet through `eth_accounts` if it is
still authorised. Write actions are gated on being connected *and* on the right chain;
triggering one while disconnected opens the wallet picker instead of failing.

`app/scripts/ops.mjs` is the exception and stays key-based on purpose — it is an operator
CLI, not the app, and reads its key from the gitignored `.env`.

---

## Repository layout

```
contracts/license_hound.py      the intelligent contract
tests/direct/                   direct-mode tests (18, ~0.7s, no server)
app/                            Vite + React + genlayer-js frontend
app/src/lib/wallet.ts           EIP-6963 wallet adapter (discovery, chain, events)
app/src/lib/indexer.ts          rebuilds state from the chain's transaction record
app/scripts/ops.mjs             operator CLI for payable calls
app/scripts/verdict.mjs         recovers a decision from a transaction
```

## Running it

```bash
npm install --prefix app
```

```bash
npm run dev --prefix app
```

The contract address lives in `app/.env.local`. Connect a wallet in the UI — the app has no
key input and never stores one. `.env` holds keys for the operator scripts only and is
gitignored.

### Contract workflow

```bash
genvm-lint check contracts/license_hound.py
```

```bash
python -m pytest tests/direct/ -q
```

```bash
genlayer deploy --contract contracts/license_hound.py
```

### Operator commands

`genlayer write` cannot attach value and every money-moving method here is payable, so
scripted operations go through genlayer-js:

```bash
node app/scripts/ops.mjs open-watch ytdl-jsinterp ytdl-org/youtube-dl 956b8c585591b401a543e409accb163eeaaa1193 Unlicense 0.4
```

```bash
AS=hunter node app/scripts/ops.mjs claim ytdl-jsinterp yt-dlp/yt-dlp fdcc954df4955267ec1627cbeb347b661a110e7c 0.2 "youtube_dl/jsinterp.py::yt_dlp/jsinterp.py"
```

```bash
node app/scripts/ops.mjs judge 0
```

`AS=hunter` switches identity: the contract will not let a watch owner file a claim on
their own watch, so exercising the full flow needs two accounts.

---

## Sequencer backpressure

Bradbury settles to L1 through a zkSync sequencer, and under load that sequencer stops
taking work:

```
error code -32603: Node is not currently accepting transactions:
pipeline backpressure (l1_sender_commit)
```

Shown raw — as it was to a reviewer mid-demo — that reads like a broken dapp. It is neither
the contract nor the transaction: the node declined the work before broadcasting anything.

`app/src/lib/errors.ts` classifies failures into a sentence plus one bit: whether the node
refused the transaction *before* it reached the mempool. Only that class is retried, and
only the submission, on a 4s / 12s / 30s backoff — resubmitting is safe precisely because
nothing was broadcast. Everything else (a wallet rejection, insufficient funds, a revert) is
reported once and left alone, because retrying it would either be futile or would send a
second transaction. When the retries run out the log says what happened and, more usefully,
that nothing was spent.

## Known network limitation

**Bradbury's public RPC currently serves writes but not contract state reads.** Its GenVM
index sits several hundred thousand blocks behind the chain head:

```
requested block 15865053 is ahead of GenVM synced block 15467203
(397850 blocks behind): genvm not synced
```

Consequently `gen_call` answers *"contract not found"* for **every** contract on the
network — verified against three unrelated contracts from the explorer's list, not just
this one. `genlayer call`, `genlayer schema`, and the trace endpoint are all affected.

The app does not wait for that. `app/src/lib/indexer.ts` rebuilds its view instead:

1. list the contract's transactions from the explorer index,
2. decode each one's calldata to recover the arguments that were submitted,
3. lift the one non-deterministic value the network actually voted on — the model's
   `derivative` boolean — out of the consensus record,
4. recompute every deterministic input locally and derive the verdict with the contract's
   own rules.

Step 4 is only legitimate because those stages are deterministic by construction: if
recomputing them locally could disagree with the validators, `strict_eq` would have
rejected the transaction. In practice it matches exactly — the browser measures claim #0 at
20.66%, the same 2066 basis points the chain recorded. Nothing subjective is invented
client-side.

When the RPC catches up, `client.readContract` against the contract's view methods becomes
the faster path; the contract exposes `stats`, `list_watches`, `get_watch`, `get_receipt`
and `get_pending` for exactly that.

## Other rough edges

- **Direct-mode tests need a Windows shim.** `gltest.direct.loader` unlinks a temp file
  while its descriptor is still open — fine on POSIX, impossible on Windows. See
  `tests/direct/conftest.py`; delete it once upstream stops doing that.
- **The explorer API sends no CORS headers**, so in development it is reached through the
  Vite proxy in `app/vite.config.ts`.
- **Similarity is crude on purpose.** Comment-stripped token shingles catch verbatim and
  lightly-edited copies. A determined re-write defeats it. That is the honest scope: this
  finds vendored code, not laundered code.

## What this is not

The Evidence Receipt records a measurement and a network vote. It is not legal advice and
it is not a finding of any court. The wording is deliberately neutral — "similarity
measured at X%, licence text absent" — because publishing an accusation about a named
project carries real risk, whoever publishes it.
