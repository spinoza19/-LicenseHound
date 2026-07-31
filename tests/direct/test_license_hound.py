"""Direct-mode tests for LicenseHound.

Direct mode runs the leader function only, so these tests cover the parts that
must be right before consensus is even involved: input validation, escrow
arithmetic, access control, and the verdict derivation that turns one model
boolean plus two measurements into a payout.

Consensus itself (whether five validators agree on `derivative`) is not
exercisable here â€” that needs the integration tests against a live network.
"""

import json

import pytest

CONTRACT = "contracts/license_hound.py"

ORIGIN_REPO = "acme/libfoo"
ORIGIN_SHA = "a" * 40
SUSPECT_REPO = "megacorp/product"
SUSPECT_SHA = "b" * 40

GEN = 10**18

# Two files that clearly share a lineage, and one that clearly does not.
ORIGINAL_SRC = """
/* libfoo ring buffer */
int foo_push(struct foo_ring *r, int value) {
    if (r->count == r->capacity) return -1;
    r->slots[(r->head + r->count) % r->capacity] = value;
    r->count += 1;
    return 0;
}
"""
COPIED_SRC = """
// vendored
int foo_push(struct foo_ring *r, int value) {
    if (r->count == r->capacity) return -1;
    r->slots[(r->head + r->count) % r->capacity] = value;
    r->count += 1;
    return 0;
}
"""
UNRELATED_SRC = """
def render_template(name, **context):
    template = environment.get_template(name)
    return template.render(**context)
"""

GPL_TEXT = "GNU GENERAL PUBLIC LICENSE Version 3, 29 June 2007 " + (
    "Everyone is permitted to copy and distribute verbatim copies of this license "
    "document, but changing it is not allowed. " * 6
)


def hex_of(account) -> str:
    """`get_pending` takes a hex string, the way a wallet or the CLI sends it;
    the fixtures hand out Address objects."""
    return getattr(account, "as_hex", None) or str(account)


def raw(repo: str, sha: str, path: str) -> str:
    return rf".*raw\.githubusercontent\.com/{repo}/{sha}/{path}$"


def mock_files(direct_vm, files: dict[str, str], missing: list[str] = ()):
    for url, body in files.items():
        direct_vm.mock_web(url, {"status": 200, "body": body})
    for url in missing:
        direct_vm.mock_web(url, {"status": 404, "body": ""})


def mock_judgement(direct_vm, derivative: bool, reasoning: str = "test"):
    direct_vm.mock_llm(
        r".*was the SUSPECT code copied or adapted.*",
        json.dumps({"derivative": derivative, "reasoning": reasoning}),
    )


@pytest.fixture
def hound(direct_deploy):
    return direct_deploy(CONTRACT)


def open_watch(hound, direct_vm, sender, bounty=GEN // 2, watch_id="w1"):
    direct_vm.sender = sender
    direct_vm.value = bounty
    hound.open_watch(watch_id, ORIGIN_REPO, ORIGIN_SHA, "GPL-3.0")
    direct_vm.value = 0
    return watch_id


def file_claim(hound, direct_vm, sender, watch_id="w1", suspect_path="vendor/foo.c", bond=GEN // 5):
    direct_vm.sender = sender
    direct_vm.value = bond
    claim_id = hound.file_claim(
        watch_id,
        SUSPECT_REPO,
        SUSPECT_SHA,
        json.dumps([{"origin": "src/foo.c", "suspect": suspect_path}]),
    )
    direct_vm.value = 0
    return claim_id


# --------------------------------------------------------------------------
# Input validation â€” the cheap, deterministic gate before any money is spent
# --------------------------------------------------------------------------
def test_branch_names_are_rejected(hound, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    direct_vm.value = GEN
    with direct_vm.expect_revert("40-char"):
        hound.open_watch("w1", ORIGIN_REPO, "main", "GPL-3.0")


def test_malformed_repo_is_rejected(hound, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    direct_vm.value = GEN
    with direct_vm.expect_revert("owner/name"):
        hound.open_watch("w1", "not-a-repo", ORIGIN_SHA, "GPL-3.0")


def test_watch_owner_cannot_claim_against_themselves(hound, direct_vm, direct_alice):
    open_watch(hound, direct_vm, direct_alice)
    direct_vm.value = GEN // 5
    with direct_vm.expect_revert("self-claim"):
        hound.file_claim(
            "w1",
            SUSPECT_REPO,
            SUSPECT_SHA,
            json.dumps([{"origin": "src/foo.c", "suspect": "vendor/foo.c"}]),
        )


def test_bond_floor_is_enforced(hound, direct_vm, direct_alice, direct_bob):
    open_watch(hound, direct_vm, direct_alice)
    direct_vm.sender = direct_bob
    direct_vm.value = 1
    with direct_vm.expect_revert("bond below minimum"):
        hound.file_claim(
            "w1",
            SUSPECT_REPO,
            SUSPECT_SHA,
            json.dumps([{"origin": "src/foo.c", "suspect": "vendor/foo.c"}]),
        )


def test_path_traversal_is_rejected(hound, direct_vm, direct_alice, direct_bob):
    open_watch(hound, direct_vm, direct_alice)
    direct_vm.sender = direct_bob
    direct_vm.value = GEN // 5
    with direct_vm.expect_revert("traversal"):
        hound.file_claim(
            "w1",
            SUSPECT_REPO,
            SUSPECT_SHA,
            json.dumps([{"origin": "../../etc/passwd", "suspect": "vendor/foo.c"}]),
        )


# --------------------------------------------------------------------------
# Verdict derivation â€” the part that decides who gets paid
# --------------------------------------------------------------------------
def test_copied_without_the_licence_is_a_violation(
    hound, direct_vm, direct_alice, direct_bob
):
    open_watch(hound, direct_vm, direct_alice)
    claim_id = file_claim(hound, direct_vm, direct_bob)

    mock_files(
        direct_vm,
        {
            raw(ORIGIN_REPO, ORIGIN_SHA, "src/foo.c"): ORIGINAL_SRC,
            raw(SUSPECT_REPO, SUSPECT_SHA, "vendor/foo.c"): COPIED_SRC,
            raw(ORIGIN_REPO, ORIGIN_SHA, "LICENSE"): GPL_TEXT,
            raw(SUSPECT_REPO, SUSPECT_SHA, "LICENSE"): "Copyright MegaCorp. All rights reserved. " * 12,
        },
    )
    mock_judgement(direct_vm, derivative=True)

    receipt = hound.adjudicate(claim_id)
    assert receipt["verdict"] == "VIOLATION"
    assert receipt["derivative"] is True
    assert receipt["attribution_present"] is False
    assert receipt["similarity_bp"] > 1500

    # bounty plus the returned bond are owed to the hunter, nothing to the owner
    assert int(hound.get_pending(hex_of(direct_bob))) == GEN // 2 + GEN // 5
    assert int(hound.get_pending(hex_of(direct_alice))) == 0


def test_copied_with_the_licence_intact_is_compliant(
    hound, direct_vm, direct_alice, direct_bob
):
    open_watch(hound, direct_vm, direct_alice)
    claim_id = file_claim(hound, direct_vm, direct_bob)

    mock_files(
        direct_vm,
        {
            raw(ORIGIN_REPO, ORIGIN_SHA, "src/foo.c"): ORIGINAL_SRC,
            raw(SUSPECT_REPO, SUSPECT_SHA, "vendor/foo.c"): COPIED_SRC,
            raw(ORIGIN_REPO, ORIGIN_SHA, "LICENSE"): GPL_TEXT,
            raw(SUSPECT_REPO, SUSPECT_SHA, "LICENSE"): GPL_TEXT,
        },
    )
    mock_judgement(direct_vm, derivative=True)

    receipt = hound.adjudicate(claim_id)
    assert receipt["verdict"] == "COMPLIANT"
    assert receipt["attribution_present"] is True
    # honest miss: the bond comes back, the bounty does not move
    assert int(hound.get_pending(hex_of(direct_bob))) == GEN // 5


def test_unrelated_code_burns_half_the_bond(hound, direct_vm, direct_alice, direct_bob):
    open_watch(hound, direct_vm, direct_alice)
    claim_id = file_claim(hound, direct_vm, direct_bob, suspect_path="app/views.py")

    mock_files(
        direct_vm,
        {
            raw(ORIGIN_REPO, ORIGIN_SHA, "src/foo.c"): ORIGINAL_SRC,
            raw(SUSPECT_REPO, SUSPECT_SHA, "app/views.py"): UNRELATED_SRC,
            raw(ORIGIN_REPO, ORIGIN_SHA, "LICENSE"): GPL_TEXT,
            raw(SUSPECT_REPO, SUSPECT_SHA, "LICENSE"): GPL_TEXT,
        },
    )
    mock_judgement(direct_vm, derivative=False)

    receipt = hound.adjudicate(claim_id)
    assert receipt["verdict"] == "UNRELATED"
    assert int(hound.get_pending(hex_of(direct_bob))) == 0

    watch = hound.get_watch("w1")
    assert int(watch["bounty"]) == GEN // 2 + (GEN // 5) // 2


def test_the_model_cannot_declare_a_violation_the_numbers_do_not_support(
    hound, direct_vm, direct_alice, direct_bob
):
    """The deterministic veto. A model saying `derivative` on two files that
    share almost nothing must not be able to move the bounty."""
    open_watch(hound, direct_vm, direct_alice)
    claim_id = file_claim(hound, direct_vm, direct_bob, suspect_path="app/views.py")

    mock_files(
        direct_vm,
        {
            raw(ORIGIN_REPO, ORIGIN_SHA, "src/foo.c"): ORIGINAL_SRC,
            raw(SUSPECT_REPO, SUSPECT_SHA, "app/views.py"): UNRELATED_SRC,
            raw(ORIGIN_REPO, ORIGIN_SHA, "LICENSE"): GPL_TEXT,
            raw(SUSPECT_REPO, SUSPECT_SHA, "LICENSE"): "Proprietary. " * 40,
        },
    )
    mock_judgement(direct_vm, derivative=True, reasoning="looks similar to me")

    receipt = hound.adjudicate(claim_id)
    assert receipt["verdict"] == "INCONCLUSIVE"
    assert "VETO" in receipt["reasoning"]
    assert int(hound.get_pending(hex_of(direct_bob))) == GEN // 5  # bond returned


def test_a_claim_settles_only_once(hound, direct_vm, direct_alice, direct_bob):
    open_watch(hound, direct_vm, direct_alice)
    claim_id = file_claim(hound, direct_vm, direct_bob)
    mock_files(
        direct_vm,
        {
            raw(ORIGIN_REPO, ORIGIN_SHA, "src/foo.c"): ORIGINAL_SRC,
            raw(SUSPECT_REPO, SUSPECT_SHA, "vendor/foo.c"): COPIED_SRC,
            raw(ORIGIN_REPO, ORIGIN_SHA, "LICENSE"): GPL_TEXT,
            raw(SUSPECT_REPO, SUSPECT_SHA, "LICENSE"): GPL_TEXT,
        },
    )
    mock_judgement(direct_vm, derivative=True)

    hound.adjudicate(claim_id)
    with direct_vm.expect_revert("already settled"):
        hound.adjudicate(claim_id)


# --------------------------------------------------------------------------
# Escrow safety â€” a funded bounty must survive the owner changing their mind,
# and several claims must be able to target one watch without inventing or
# stranding money
# --------------------------------------------------------------------------
def mock_violation_evidence(direct_vm, suspect_path="vendor/foo.c"):
    """Copied code, and a suspect repo shipping its own proprietary notice."""
    mock_files(
        direct_vm,
        {
            raw(ORIGIN_REPO, ORIGIN_SHA, "src/foo.c"): ORIGINAL_SRC,
            raw(SUSPECT_REPO, SUSPECT_SHA, suspect_path): COPIED_SRC,
            raw(ORIGIN_REPO, ORIGIN_SHA, "LICENSE"): GPL_TEXT,
            raw(SUSPECT_REPO, SUSPECT_SHA, "LICENSE"): "Copyright MegaCorp. "
            "All rights reserved. " * 12,
        },
    )


def test_owner_cannot_close_a_watch_while_a_claim_is_pending(
    hound, direct_vm, direct_alice, direct_bob
):
    """The rug this guard exists to stop: a damaging claim arrives, and the
    owner takes the bounty back before anyone can adjudicate it."""
    open_watch(hound, direct_vm, direct_alice)
    file_claim(hound, direct_vm, direct_bob)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("awaiting adjudication"):
        hound.close_watch("w1")

    watch = hound.get_watch("w1")
    assert watch["open"] is True
    assert int(watch["bounty"]) == GEN // 2
    assert watch["open_claims"] == 1
    assert watch["closable"] is False
    assert int(hound.get_pending(hex_of(direct_alice))) == 0


def test_the_watch_becomes_closable_once_the_claim_settles(
    hound, direct_vm, direct_alice, direct_bob
):
    """The guard delays the owner, it does not trap them. Adjudication is
    permissionless, so the owner can always resolve the claim and then leave."""
    open_watch(hound, direct_vm, direct_alice)
    claim_id = file_claim(hound, direct_vm, direct_bob)

    mock_files(
        direct_vm,
        {
            raw(ORIGIN_REPO, ORIGIN_SHA, "src/foo.c"): ORIGINAL_SRC,
            raw(SUSPECT_REPO, SUSPECT_SHA, "vendor/foo.c"): COPIED_SRC,
            raw(ORIGIN_REPO, ORIGIN_SHA, "LICENSE"): GPL_TEXT,
            raw(SUSPECT_REPO, SUSPECT_SHA, "LICENSE"): GPL_TEXT,
        },
    )
    mock_judgement(direct_vm, derivative=True)
    assert hound.adjudicate(claim_id)["verdict"] == "COMPLIANT"

    assert hound.get_watch("w1")["closable"] is True
    direct_vm.sender = direct_alice
    hound.close_watch("w1")
    assert int(hound.get_pending(hex_of(direct_alice))) == GEN // 2
    assert hound.get_watch("w1")["open"] is False


def test_a_violation_drains_the_bounty_and_closes_the_watch(
    hound, direct_vm, direct_alice, direct_bob
):
    open_watch(hound, direct_vm, direct_alice)
    claim_id = file_claim(hound, direct_vm, direct_bob)
    mock_violation_evidence(direct_vm)
    mock_judgement(direct_vm, derivative=True)

    assert hound.adjudicate(claim_id)["verdict"] == "VIOLATION"

    watch = hound.get_watch("w1")
    assert watch["open"] is False
    assert int(watch["bounty"]) == 0
    assert watch["open_claims"] == 0
    assert int(hound.get_pending(hex_of(direct_bob))) == GEN // 2 + GEN // 5


def test_no_new_claim_can_be_filed_against_a_drained_watch(
    hound, direct_vm, direct_alice, direct_bob, direct_charlie
):
    open_watch(hound, direct_vm, direct_alice)
    claim_id = file_claim(hound, direct_vm, direct_bob)
    mock_violation_evidence(direct_vm)
    mock_judgement(direct_vm, derivative=True)
    hound.adjudicate(claim_id)

    direct_vm.sender = direct_charlie
    direct_vm.value = GEN // 5
    with direct_vm.expect_revert("watch closed"):
        hound.file_claim(
            "w1",
            SUSPECT_REPO,
            SUSPECT_SHA,
            json.dumps([{"origin": "src/foo.c", "suspect": "vendor/foo.c"}]),
        )


def test_a_claim_in_flight_when_the_bounty_drains_still_settles_safely(
    hound, direct_vm, direct_alice, direct_bob, direct_charlie
):
    """Two hunters file before either is judged. Settlement is
    first-past-the-post: the first violation takes the pool, and the second
    hunter is made whole with their bond rather than paid from an empty one."""
    open_watch(hound, direct_vm, direct_alice)
    first = file_claim(hound, direct_vm, direct_bob)
    second = file_claim(hound, direct_vm, direct_charlie)
    assert hound.get_watch("w1")["open_claims"] == 2

    mock_violation_evidence(direct_vm)
    mock_judgement(direct_vm, derivative=True)

    assert hound.adjudicate(first)["verdict"] == "VIOLATION"
    # The watch is already drained and closed; the second claim is still judged.
    assert hound.adjudicate(second)["verdict"] == "VIOLATION"

    assert int(hound.get_pending(hex_of(direct_bob))) == GEN // 2 + GEN // 5
    assert int(hound.get_pending(hex_of(direct_charlie))) == GEN // 5
    assert int(hound.get_watch("w1")["bounty"]) == 0
    assert hound.get_watch("w1")["open_claims"] == 0


def test_a_junk_claim_on_a_closed_watch_pays_the_owner_not_a_dead_pool(
    hound, direct_vm, direct_alice, direct_bob, direct_charlie
):
    """Nothing may be left owned by a closed watch â€” it can never pay out
    again. The junk-claim penalty goes to the owner instead, and the books
    still balance against everything that was deposited."""
    open_watch(hound, direct_vm, direct_alice)
    first = file_claim(hound, direct_vm, direct_bob)
    second = file_claim(hound, direct_vm, direct_charlie, suspect_path="app/views.py")

    mock_violation_evidence(direct_vm)
    mock_files(
        direct_vm, {raw(SUSPECT_REPO, SUSPECT_SHA, "app/views.py"): UNRELATED_SRC}
    )
    # Mocks are matched in registration order, so the narrow pattern — which
    # only hits the prompt carrying the unrelated file — has to go first.
    direct_vm.mock_llm(
        r".*app/views\.py.*",
        json.dumps({"derivative": False, "reasoning": "different program"}),
    )
    mock_judgement(direct_vm, derivative=True)

    assert hound.adjudicate(first)["verdict"] == "VIOLATION"
    assert hound.adjudicate(second)["verdict"] == "UNRELATED"

    half = (GEN // 5) // 2
    assert int(hound.get_pending(hex_of(direct_alice))) == half
    assert int(hound.get_watch("w1")["bounty"]) == 0

    deposited = (GEN // 2) + (GEN // 5) + (GEN // 5)
    credited = (
        int(hound.get_pending(hex_of(direct_alice)))
        + int(hound.get_pending(hex_of(direct_bob)))
        + int(hound.get_pending(hex_of(direct_charlie)))
    )
    burned = (GEN // 5) - half
    assert credited + burned + int(hound.get_watch("w1")["bounty"]) == deposited


def test_a_missing_file_is_reported_as_an_external_error(
    hound, direct_vm, direct_alice, direct_bob
):
    open_watch(hound, direct_vm, direct_alice)
    claim_id = file_claim(hound, direct_vm, direct_bob, suspect_path="nope/gone.c")
    mock_files(
        direct_vm,
        {raw(ORIGIN_REPO, ORIGIN_SHA, "src/foo.c"): ORIGINAL_SRC},
        missing=[raw(SUSPECT_REPO, SUSPECT_SHA, "nope/gone.c")],
    )
    with direct_vm.expect_revert("[EXTERNAL]"):
        hound.adjudicate(claim_id)
