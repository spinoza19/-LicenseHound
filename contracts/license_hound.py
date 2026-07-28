# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
LicenseHound — an on-chain bounty court for open-source license violations.

Maintainers of copyleft libraries (GPL / AGPL / MPL) fund a Watch on their repo.
Hunters file a Claim: "this commercial repo copied your code without complying".
The contract itself fetches BOTH sources, measures similarity deterministically,
asks an LLM only for the judgment that code cannot make, and settles the escrow.

Architecture boundary
---------------------
frontend/backend : discovery, repo search, branch -> commit SHA resolution, UI,
                   indexing, non-authoritative similarity previews.
this contract    : escrow + evidence acquisition + the judgment + settlement +
                   the permanent Evidence Receipt.
external sources : raw.githubusercontent.com. Never trusted from the leader --
                   every validator re-fetches independently.

The determinism trick
---------------------
Every fetch is pinned to a 40-hex commit SHA, never a branch. Content addressed
by SHA is immutable, so "fetch the evidence" becomes a reproducible read and can
be wrapped in strict_eq. All the non-determinism is pushed into one small,
well-scoped judgment call whose input is byte-identical for leader and validators.
"""

import json
import re
from dataclasses import dataclass

from genlayer import *

# ---------------------------------------------------------------------------
# Error classification. Validators must agree on HOW a failure happened, not
# just that it happened, otherwise the failure path itself breaks consensus.
# ---------------------------------------------------------------------------
ERR_EXPECTED = "[EXPECTED]"  # business logic  -> deterministic, must match exactly
ERR_EXTERNAL = "[EXTERNAL]"  # 4xx from GitHub -> deterministic, must match exactly
ERR_TRANSIENT = "[TRANSIENT]"  # 5xx / 429     -> agree if both are transient
ERR_LLM = "[LLM_ERROR]"  # model misbehaved   -> disagree, force rotation

# Verdicts
VIOLATION = "VIOLATION"
COMPLIANT = "COMPLIANT"
UNRELATED = "UNRELATED"
INCONCLUSIVE = "INCONCLUSIVE"

# Claim lifecycle
PENDING = "PENDING"

# Tunables (compute + LLM cost control)
#
# The prompt budget matters more than it looks: an oversized prompt made half
# the validators time out, which reads as disagreement and kills consensus.
MAX_PAIRS = 3  # file pairs examined per claim
MAX_EXCERPT = 1500  # chars of each file handed to the model
MIN_JACCARD_BP = 1500  # 15.00% — below this a VIOLATION verdict is vetoed
LICENSE_MATCH_BP = 6000  # suspect license must be 60% the origin's to count
SHINGLE = 5  # token n-gram width for the similarity measure

LICENSE_CANDIDATES = (
    "LICENSE",
    "LICENSE.txt",
    "LICENSE.md",
    "COPYING",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
)

_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_REPO_RE = re.compile(r"^[A-Za-z0-9._-]{1,39}/[A-Za-z0-9._-]{1,100}$")
_PATH_RE = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")


# ---------------------------------------------------------------------------
# Storage models
# ---------------------------------------------------------------------------
@allow_storage
@dataclass
class Watch:
    owner: Address
    origin_repo: str  # "owner/repo"
    origin_sha: str  # 40 hex chars, immutable content anchor
    license_id: str  # "GPL-3.0", "AGPL-3.0", ...
    bounty: u256  # atto-GEN still payable
    open: bool


@allow_storage
@dataclass
class Claim:
    watch_id: str
    reporter: Address
    suspect_repo: str
    suspect_sha: str
    pairs_json: str  # [{"origin": "...", "suspect": "..."}]
    bond: u256
    verdict: str
    similarity_bp: u256  # measured by code, 0..10000
    derivative: bool
    attribution_present: bool
    reasoning: str
    settled: bool


class LicenseHound(gl.Contract):
    owner: Address
    min_bond: u256

    watches: TreeMap[str, Watch]
    watch_ids: DynArray[str]

    claims: TreeMap[u256, Claim]
    claims_of_watch: TreeMap[str, DynArray[u256]]
    next_claim_id: u256

    pending: TreeMap[Address, u256]  # pull-payment ledger

    # O(1) stats for the UI
    stat_violations: u256
    stat_settled: u256

    def __init__(self) -> None:
        self.owner = gl.message.sender_address
        self.min_bond = u256(10**17)  # 0.1 GEN
        self.next_claim_id = u256(0)
        self.stat_violations = u256(0)
        self.stat_settled = u256(0)

    # -----------------------------------------------------------------------
    # 1. Maintainer opens a Watch and funds the bounty
    # -----------------------------------------------------------------------
    @gl.public.write.payable
    def open_watch(
        self, watch_id: str, origin_repo: str, origin_sha: str, license_id: str
    ) -> str:
        if watch_id in self.watches:
            raise gl.vm.UserError(f"{ERR_EXPECTED} watch_id already used")
        if not (1 <= len(watch_id) <= 64):
            raise gl.vm.UserError(f"{ERR_EXPECTED} bad watch_id length")
        _require_repo(origin_repo)
        _require_sha(origin_sha)
        if gl.message.value == 0:
            raise gl.vm.UserError(f"{ERR_EXPECTED} bounty must be > 0")

        self.watches[watch_id] = Watch(
            owner=gl.message.sender_address,
            origin_repo=origin_repo,
            origin_sha=origin_sha,
            license_id=license_id,
            bounty=u256(gl.message.value),
            open=True,
        )
        self.watch_ids.append(watch_id)
        # Returned (not just stored) so a client can reconstruct state from the
        # transaction receipt when the RPC's read path is unavailable.
        return watch_id

    @gl.public.write.payable
    def top_up(self, watch_id: str) -> None:
        watch = self._watch(watch_id)
        if not watch.open:
            raise gl.vm.UserError(f"{ERR_EXPECTED} watch closed")
        watch.bounty = u256(watch.bounty + gl.message.value)

    # -----------------------------------------------------------------------
    # 2. Hunter files a Claim. Cheap + fully deterministic: no LLM, no web.
    #    Everything rejectable by arithmetic gets rejected here.
    # -----------------------------------------------------------------------
    @gl.public.write.payable
    def file_claim(
        self, watch_id: str, suspect_repo: str, suspect_sha: str, pairs_json: str
    ) -> u256:
        watch = self._watch(watch_id)
        if not watch.open:
            raise gl.vm.UserError(f"{ERR_EXPECTED} watch closed")
        if gl.message.value < self.min_bond:
            raise gl.vm.UserError(f"{ERR_EXPECTED} bond below minimum")
        if gl.message.sender_address == watch.owner:
            raise gl.vm.UserError(f"{ERR_EXPECTED} watch owner cannot self-claim")

        _require_repo(suspect_repo)
        _require_sha(suspect_sha)
        if suspect_repo.lower() == watch.origin_repo.lower():
            raise gl.vm.UserError(f"{ERR_EXPECTED} suspect equals origin")

        pairs = _parse_pairs(pairs_json)

        claim_id = u256(self.next_claim_id)
        self.claims[claim_id] = Claim(
            watch_id=watch_id,
            reporter=gl.message.sender_address,
            suspect_repo=suspect_repo,
            suspect_sha=suspect_sha,
            pairs_json=json.dumps(pairs, sort_keys=True),
            bond=u256(gl.message.value),
            verdict=PENDING,
            similarity_bp=u256(0),
            derivative=False,
            attribution_present=False,
            reasoning="",
            settled=False,
        )
        self.claims_of_watch.get_or_insert_default(watch_id).append(claim_id)
        self.next_claim_id = u256(claim_id + 1)
        return claim_id

    # -----------------------------------------------------------------------
    # 3. Adjudication — the only method that needs GenLayer
    # -----------------------------------------------------------------------
    @gl.public.write
    def adjudicate(self, claim_id: u256) -> dict:
        claim = self._claim(claim_id)
        if claim.settled:
            raise gl.vm.UserError(f"{ERR_EXPECTED} claim already settled")
        watch = self._watch(claim.watch_id)

        origin_repo = watch.origin_repo
        origin_sha = watch.origin_sha
        suspect_repo = claim.suspect_repo
        suspect_sha = claim.suspect_sha
        license_id = watch.license_id
        pairs = json.loads(claim.pairs_json)

        # -- Stage 1: code evidence. SHA-pinned => reproducible => strict_eq. --
        def fetch_code_evidence() -> list:
            out = []
            for pair in pairs:
                left = _normalize(_raw(origin_repo, origin_sha, pair["origin"]))
                right = _normalize(_raw(suspect_repo, suspect_sha, pair["suspect"]))
                out.append(
                    {
                        "origin_path": pair["origin"],
                        "suspect_path": pair["suspect"],
                        "byte_identical": left == right,
                        "jaccard_bp": _jaccard_bp(left, right),
                        "origin_excerpt": left[:MAX_EXCERPT],
                        "suspect_excerpt": right[:MAX_EXCERPT],
                    }
                )
            return out

        evidence = gl.eq_principle.strict_eq(fetch_code_evidence)

        # -- Stage 2: attribution. Answered by arithmetic, not by a model.
        #    "Does the suspect ship the same licence the origin ships?" is a
        #    text-comparison question, so it has no business being a judgment
        #    call — and every question moved out of the prompt is one less
        #    thing five validators have to agree about.
        def measure_attribution() -> dict:
            origin_licence = _best_license(origin_repo, origin_sha)
            suspect_licence = _best_license(suspect_repo, suspect_sha)
            if not origin_licence or not suspect_licence:
                return {
                    "license_match_bp": 0,
                    "suspect_has_license_file": bool(suspect_licence),
                }
            return {
                "license_match_bp": _jaccard_bp(origin_licence, suspect_licence),
                "suspect_has_license_file": True,
            }

        attribution = gl.eq_principle.strict_eq(measure_attribution)
        attribution_present = attribution["license_match_bp"] >= LICENSE_MATCH_BP

        # Ground truth the model is forbidden from contradicting.
        max_bp = 0
        for item in evidence:
            if item["jaccard_bp"] > max_bp:
                max_bp = item["jaccard_bp"]
        any_identical = any(item["byte_identical"] for item in evidence)

        # -- Stage 3: the judgment. Exactly ONE open question is left for the
        #    model: is the suspect code derived from the original? Everything
        #    else was measured. A single boolean is something five independent
        #    validators can actually agree on.
        def judge() -> str:
            raw = gl.nondet.exec_prompt(
                _build_prompt(evidence, max_bp, any_identical),
                response_format="json",
            )
            return json.dumps(_validate_llm(raw), sort_keys=True)

        decision = json.loads(
            gl.eq_principle.prompt_comparative(
                judge,
                "Two answers are equivalent if and only if the `derivative` boolean "
                "is exactly the same in both. The `reasoning` field is free text and "
                "MUST be ignored entirely when deciding equivalence.",
            )
        )
        derivative = decision["derivative"]
        reasoning = decision["reasoning"]

        # -- Stage 4: the verdict is derived, never delegated. --------------
        if not derivative:
            verdict = UNRELATED
        elif attribution_present:
            verdict = COMPLIANT
        else:
            verdict = VIOLATION

        # Deterministic vetoes: a model may not spend money the measurements
        # do not support, in either direction.
        if verdict == VIOLATION and max_bp < MIN_JACCARD_BP and not any_identical:
            verdict = INCONCLUSIVE
            reasoning = "VETO: measured similarity below threshold. " + reasoning
        if verdict == UNRELATED and any_identical:
            verdict = INCONCLUSIVE
            reasoning = "VETO: a file pair is byte-identical. " + reasoning

        # -- Settlement -------------------------------------------------------
        claim.verdict = verdict
        claim.similarity_bp = u256(max_bp)
        claim.derivative = derivative
        claim.attribution_present = attribution_present
        claim.reasoning = reasoning[:900]
        claim.settled = True
        self.stat_settled = u256(self.stat_settled + 1)

        if verdict == VIOLATION:
            # Hunter takes the bounty and gets the bond back. Watch closes.
            self._credit(claim.reporter, u256(watch.bounty + claim.bond))
            watch.bounty = u256(0)
            watch.open = False
            self.stat_violations = u256(self.stat_violations + 1)
        elif verdict == UNRELATED:
            # Junk claim: half the bond funds the pool, half is burned.
            half = u256(claim.bond // 2)
            watch.bounty = u256(watch.bounty + half)
        else:
            # COMPLIANT / INCONCLUSIVE: honest miss, bond returned.
            self._credit(claim.reporter, claim.bond)

        # The full receipt is returned, not just the verdict, so the decision
        # survives in the transaction record even if state reads are unavailable.
        return self._receipt(claim_id, claim, watch)

    # -----------------------------------------------------------------------
    # 4. Money out (pull payments)
    # -----------------------------------------------------------------------
    @gl.public.write
    def withdraw(self) -> str:
        who = gl.message.sender_address
        amount = self.pending.get(who, u256(0))
        if amount == 0:
            raise gl.vm.UserError(f"{ERR_EXPECTED} nothing to withdraw")
        self.pending[who] = u256(0)
        gl.chain.Account(who).emit_transfer(u256(amount))
        return str(amount)

    @gl.public.write
    def close_watch(self, watch_id: str) -> None:
        watch = self._watch(watch_id)
        if gl.message.sender_address != watch.owner:
            raise gl.vm.UserError(f"{ERR_EXPECTED} not the watch owner")
        if not watch.open:
            raise gl.vm.UserError(f"{ERR_EXPECTED} already closed")
        refund = u256(watch.bounty)
        watch.bounty = u256(0)
        watch.open = False
        if refund > 0:
            self._credit(watch.owner, refund)

    @gl.public.write
    def set_min_bond(self, amount: u256) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERR_EXPECTED} not the contract owner")
        self.min_bond = u256(amount)

    # -----------------------------------------------------------------------
    # Views
    # -----------------------------------------------------------------------
    @gl.public.view
    def get_watch(self, watch_id: str) -> dict:
        watch = self._watch(watch_id)
        return {
            "watch_id": watch_id,
            "owner": watch.owner.as_hex,
            "origin_repo": watch.origin_repo,
            "origin_sha": watch.origin_sha,
            "license_id": watch.license_id,
            "bounty": str(watch.bounty),
            "open": watch.open,
            "claims": [str(cid) for cid in self.claims_of_watch.get(watch_id, [])],
        }

    @gl.public.view
    def list_watches(self) -> list:
        out = []
        for watch_id in self.watch_ids:
            watch = self.watches[watch_id]
            out.append(
                {
                    "watch_id": watch_id,
                    "origin_repo": watch.origin_repo,
                    "origin_sha": watch.origin_sha,
                    "license_id": watch.license_id,
                    "bounty": str(watch.bounty),
                    "open": watch.open,
                    "claim_count": len(self.claims_of_watch.get(watch_id, [])),
                }
            )
        return out

    @gl.public.view
    def get_receipt(self, claim_id: u256) -> dict:
        """The Evidence Receipt — the artifact a maintainer attaches to a
        takedown notice. Everything in it was verified by every validator."""
        claim = self._claim(claim_id)
        return self._receipt(claim_id, claim, self.watches[claim.watch_id])

    @gl.public.view
    def get_pending(self, address: str) -> str:
        return str(self.pending.get(Address(address), u256(0)))

    @gl.public.view
    def stats(self) -> dict:
        return {
            "watches": len(self.watch_ids),
            "claims": int(self.next_claim_id),
            "settled": int(self.stat_settled),
            "violations": int(self.stat_violations),
            "min_bond": str(self.min_bond),
        }

    # -----------------------------------------------------------------------
    # Internals
    # -----------------------------------------------------------------------
    def _watch(self, watch_id: str) -> Watch:
        if watch_id not in self.watches:
            raise gl.vm.UserError(f"{ERR_EXPECTED} unknown watch")
        return self.watches[watch_id]

    def _claim(self, claim_id: u256) -> Claim:
        if claim_id not in self.claims:
            raise gl.vm.UserError(f"{ERR_EXPECTED} unknown claim")
        return self.claims[claim_id]

    def _credit(self, who: Address, amount: u256) -> None:
        self.pending[who] = u256(self.pending.get(who, u256(0)) + amount)

    def _receipt(self, claim_id: u256, claim: Claim, watch: Watch) -> dict:
        return {
            "claim_id": str(claim_id),
            "watch_id": claim.watch_id,
            "verdict": claim.verdict,
            "settled": claim.settled,
            "similarity_bp": int(claim.similarity_bp),
            "derivative": claim.derivative,
            "attribution_present": claim.attribution_present,
            "reasoning": claim.reasoning,
            "reporter": claim.reporter.as_hex,
            "bond": str(claim.bond),
            "license_id": watch.license_id,
            "origin": {"repo": watch.origin_repo, "sha": watch.origin_sha},
            "suspect": {"repo": claim.suspect_repo, "sha": claim.suspect_sha},
            "pairs": json.loads(claim.pairs_json),
        }


# ---------------------------------------------------------------------------
# Validation helpers (deterministic, run outside nondet blocks)
# ---------------------------------------------------------------------------
def _require_repo(repo: str) -> None:
    if _REPO_RE.match(repo) is None:
        raise gl.vm.UserError(f"{ERR_EXPECTED} repo must be owner/name")


def _require_sha(sha: str) -> None:
    if _SHA_RE.match(sha) is None:
        raise gl.vm.UserError(
            f"{ERR_EXPECTED} a full 40-char lowercase commit SHA is required; "
            f"branch names are not accepted because they are mutable"
        )


def _parse_pairs(pairs_json: str) -> list:
    try:
        pairs = json.loads(pairs_json)
    except Exception:
        raise gl.vm.UserError(f"{ERR_EXPECTED} pairs_json is not valid JSON")
    if not isinstance(pairs, list) or not (1 <= len(pairs) <= MAX_PAIRS):
        raise gl.vm.UserError(f"{ERR_EXPECTED} need 1..{MAX_PAIRS} file pairs")

    clean = []
    for pair in pairs:
        if not isinstance(pair, dict):
            raise gl.vm.UserError(f"{ERR_EXPECTED} each pair must be an object")
        origin = str(pair.get("origin", ""))
        suspect = str(pair.get("suspect", ""))
        if _PATH_RE.match(origin) is None or _PATH_RE.match(suspect) is None:
            raise gl.vm.UserError(f"{ERR_EXPECTED} invalid file path in pairs")
        if ".." in origin or ".." in suspect:
            raise gl.vm.UserError(f"{ERR_EXPECTED} path traversal rejected")
        clean.append({"origin": origin, "suspect": suspect})
    return clean


# ---------------------------------------------------------------------------
# Evidence helpers (run INSIDE nondet blocks)
# ---------------------------------------------------------------------------
def _raw_url(repo: str, sha: str, path: str) -> str:
    return f"https://raw.githubusercontent.com/{repo}/{sha}/{path}"


def _body_text(body) -> str:
    if body is None:
        return ""
    return bytes(body).decode("utf-8", errors="replace")


def _raw(repo: str, sha: str, path: str) -> str:
    res = gl.nondet.web.get(_raw_url(repo, sha, path))
    if res.status == 404:
        raise gl.vm.UserError(f"{ERR_EXTERNAL} 404 {repo}@{sha[:12]}/{path}")
    if res.status == 429 or res.status >= 500:
        raise gl.vm.UserError(f"{ERR_TRANSIENT} github status {res.status}")
    if res.status != 200:
        raise gl.vm.UserError(f"{ERR_EXTERNAL} github status {res.status}")
    return _body_text(res.body)


def _raw_optional(repo: str, sha: str, path: str):
    res = gl.nondet.web.get(_raw_url(repo, sha, path))
    if res.status == 200:
        return _body_text(res.body)
    if res.status == 404:
        return None
    if res.status == 429 or res.status >= 500:
        raise gl.vm.UserError(f"{ERR_TRANSIENT} github status {res.status}")
    raise gl.vm.UserError(f"{ERR_EXTERNAL} github status {res.status}")


def _best_license(repo: str, sha: str) -> str:
    """Return the first licence-ish file found, normalised for comparison."""
    for name in LICENSE_CANDIDATES:
        text = _raw_optional(repo, sha, name)
        if text is not None and len(text.strip()) > 200:
            return _collapse(text).lower()
    return ""


def _collapse(text: str) -> str:
    return " ".join(text.split())


def _normalize(source: str) -> str:
    """Strip comments and whitespace so similarity reflects logic, not layout.

    Deliberately language-agnostic and crude: identical normalization on both
    sides is what matters, not perfect parsing.
    """
    source = re.sub(r"/\*.*?\*/", " ", source, flags=re.S)
    source = re.sub(r'"""(?:.|\n)*?"""', " ", source)
    source = re.sub(r"//[^\n]*", " ", source)
    source = re.sub(r"#[^\n]*", " ", source)
    return _collapse(source)


def _jaccard_bp(left: str, right: str) -> int:
    """Similarity in basis points (0..10000) over token n-grams. Integer math
    only — no floats, so every validator computes the identical number."""
    left_grams = _shingles(left)
    right_grams = _shingles(right)
    if not left_grams or not right_grams:
        return 0
    intersection = len(left_grams & right_grams)
    union = len(left_grams | right_grams)
    if union == 0:
        return 0
    return (intersection * 10000) // union


def _shingles(text: str) -> set:
    tokens = text.split()
    if len(tokens) < SHINGLE:
        return {" ".join(tokens)} if tokens else set()
    return {" ".join(tokens[i : i + SHINGLE]) for i in range(len(tokens) - SHINGLE + 1)}


# ---------------------------------------------------------------------------
# The judgment
# ---------------------------------------------------------------------------
def _build_prompt(evidence: list, max_bp: int, any_identical: bool) -> str:
    """One question, asked as tersely as it can be asked.

    Each excerpt appears exactly once. An earlier version pasted the whole
    evidence structure in as JSON *and* restated the excerpts, which doubled the
    prompt and timed validators out.
    """
    blocks = []
    for i, item in enumerate(evidence, start=1):
        blocks.append(
            f"--- PAIR {i} "
            f"(measured similarity {item['jaccard_bp']}/10000"
            f"{', byte-identical' if item['byte_identical'] else ''}) ---\n"
            f"[ORIGINAL {item['origin_path']}]\n{item['origin_excerpt']}\n"
            f"[SUSPECT {item['suspect_path']}]\n{item['suspect_excerpt']}"
        )

    return f"""You are a software provenance analyst. Answer exactly one question.

QUESTION: was the SUSPECT code copied or adapted from the ORIGINAL code?

Answer true only if the suspect code is a derivative of the original. Answer
false when the resemblance is explained by any of: shared boilerplate, ordinary
idioms of the language, both files calling the same third-party API, generated
code, or both projects independently copying a common upstream source.

Measured by deterministic code, do not contradict these numbers:
  highest_similarity = {max_bp}/10000
  any_pair_byte_identical = {str(any_identical).lower()}

{chr(10).join(blocks)}

Reply with JSON only:
{{"derivative": true, "reasoning": "1 to 3 sentences citing what you relied on"}}"""


def _validate_llm(raw) -> dict:
    """Models drift in shape. Coerce hard, reject loudly."""
    if not isinstance(raw, dict):
        raise gl.vm.UserError(f"{ERR_LLM} response was not a JSON object")

    if "derivative" not in raw and "is_derivative" not in raw:
        raise gl.vm.UserError(f"{ERR_LLM} no derivative field. keys={list(raw.keys())}")

    reasoning = raw.get("reasoning")
    if reasoning is None:
        reasoning = raw.get("explanation", "")

    return {
        "derivative": _as_bool(raw.get("derivative", raw.get("is_derivative"))),
        "reasoning": str(reasoning)[:900],
    }


def _as_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "1")
    if isinstance(value, int):
        return value != 0
    return False
