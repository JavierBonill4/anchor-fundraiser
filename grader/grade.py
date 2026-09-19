#!/usr/bin/env python3
"""
Solana Summer grader — Assignment 04, Fundraiser.

SEALED. Its blob SHA is pinned; editing it fails the submission.

This assignment is open-ended: you pick the feature. So there is no canonical
suite — there is nothing canonical to test. What can be checked mechanically,
without anyone knowing which of the five options you chose, is whether you
actually shipped something:

  1. build     `anchor build` produces a program.
  2. tests     Your suite runs green, with at least three more passing tests
               than the eleven the starter ships.
  3. surface   The built IDL has an instruction, an account, or an account
               field that the starter does not. A feature that changes no
               on-chain surface is a feature that does not exist.
  4. errors    At least one `#[error_code]` variant the starter does not have.
               Checkpoint 6 asks you to assert on YOUR error in the abuse
               case; you cannot do that without declaring one.

Those four gates are reported in the `canonical` slot of result.json — the
site already reads that shape and awards only when passed == total, which is
exactly the behaviour wanted here. `notes` names the gate that failed.

What this does NOT check is whether the feature is any good, or whether the
tests are meaningful. It cannot: you own the harness. That is what the pull
request in Checkpoint 7 is for, and why this grader is a filter rather than a
judge — it exists so that what reaches human review already builds and runs.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IDL = ROOT / "target" / "idl" / "fundraiser.json"
ANCHOR_TOML = ROOT / "Anchor.toml"
BASELINE = Path(__file__).resolve().parent / "baseline.json"
RESULT = ROOT / "result.json"

CHALLENGE_ID = "fundraiser-feature"

# Pinned. Anchor.toml has to stay editable — the starter ships a declare_id!
# whose keypair it does not ship, so `anchor keys sync` rewrites both the
# program id and Anchor.toml, and every learner has to run it. That leaves the
# [scripts] test line editable too, so it is overwritten with this before the
# suite runs rather than trusted.
TEST_COMMAND = (
    "yarn run ts-mocha -p ./tsconfig.json -t 1000000 "
    "--reporter spec tests/**/*.ts"
)

PASSING = re.compile(r"(\d+)\s+passing")
FAILING = re.compile(r"(\d+)\s+failing")

notes: list[str] = []


def norm(name: str) -> str:
    """snake_case, camelCase and PascalCase all collapse to the same key."""
    return name.replace("_", "").replace("-", "").lower()


def run(cmd: list[str], timeout: int = 1500):
    try:
        proc = subprocess.run(
            cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        return 1, "timed out"
    except FileNotFoundError:
        return 1, f"{cmd[0]}: not found"
    return proc.returncode, proc.stdout + proc.stderr


def pin_test_script() -> None:
    """Force [scripts] test back to the pinned command."""
    if not ANCHOR_TOML.exists():
        return
    lines = ANCHOR_TOML.read_text().splitlines()
    out, in_scripts, replaced = [], False, False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("["):
            if in_scripts and not replaced:
                out.append(f'test = "{TEST_COMMAND}"')
                replaced = True
            in_scripts = stripped == "[scripts]"
        if in_scripts and stripped.startswith("test") and "=" in stripped:
            out.append(f'test = "{TEST_COMMAND}"')
            replaced = True
            continue
        out.append(line)
    if in_scripts and not replaced:
        out.append(f'test = "{TEST_COMMAND}"')
        replaced = True
    if not replaced:
        out.append("")
        out.append("[scripts]")
        out.append(f'test = "{TEST_COMMAND}"')
    ANCHOR_TOML.write_text("\n".join(out) + "\n")


def idl_surface(idl: dict) -> tuple[dict, dict, dict]:
    """
    (instructions, {account: fields}, errors), each a {normalized: as-written}
    map.

    Keys are normalized so the hand-written baseline can use snake_case and
    still match the camelCase Anchor 1.x emits. The values keep the original
    spelling, because a learner reading "claimmilestone" in the feedback would
    reasonably wonder what it is talking about.
    """
    instructions = {norm(i["name"]): i["name"] for i in idl.get("instructions", [])}

    # Anchor 1.x puts account FIELDS in `types`, leaving `accounts` as name +
    # discriminator. Older layouts inline them. Read both.
    fields: dict[str, dict] = {}
    for entry in idl.get("types", []) + idl.get("accounts", []):
        shape = entry.get("type")
        if not isinstance(shape, dict) or shape.get("kind") != "struct":
            continue
        got = {norm(f["name"]): f["name"] for f in shape.get("fields", []) or []}
        fields.setdefault(norm(entry["name"]), {}).update(got)

    accounts = {
        norm(a["name"]): (a["name"], fields.get(norm(a["name"]), {}))
        for a in idl.get("accounts", [])
    }

    errors = {norm(e["name"]): e["name"] for e in idl.get("errors", [])}
    return instructions, accounts, errors


def main() -> int:
    base = json.loads(BASELINE.read_text())

    gates = {"build": False, "tests": False, "surface": False, "errors": False}
    passing = failing = 0

    # ── 0. the program id the starter declares is not the one you build ──
    code, out = run(["anchor", "keys", "sync"], timeout=300)
    if code != 0:
        notes.append(
            "`anchor keys sync` failed. Without it the built program id does "
            "not match declare_id! and every test fails with "
            "DeclaredProgramIdMismatch."
        )
        notes.append(out.strip().splitlines()[-1][:200] if out.strip() else "")

    # ── 1. build ────────────────────────────────────────────────────────
    code, out = run(["anchor", "build"])
    if code != 0 or not IDL.exists():
        notes.append("`anchor build` failed, so nothing else could be checked.")
        for line in out.splitlines():
            if line.startswith("error[") or line.startswith("error:"):
                notes.append(line.strip()[:200])
                break
        return emit(gates, passing, failing)
    gates["build"] = True

    # ── 2. your tests, on your program ──────────────────────────────────
    pin_test_script()
    code, out = run(["anchor", "test", "--skip-build"])

    passing = sum(int(m.group(1)) for m in PASSING.finditer(out))
    failing = sum(int(m.group(1)) for m in FAILING.finditer(out))

    # Anchor 1.0 replaced solana-test-validator with surfpool as the backend
    # for `anchor test`, and surfpool is a separate install. When it is
    # missing the command dies before a single test runs — mocha prints
    # nothing, and reporting that as "your tests failed" blames the learner
    # for our toolchain.
    #
    # Detect it by the absence of ANY test result rather than by matching an
    # error string, so a different validator failure is caught too, and retry
    # on the legacy validator the Solana toolchain still ships.
    if code != 0 and passing == 0 and failing == 0:
        notes.append(
            "The default validator produced no test output, so the suite was "
            "re-run on the legacy validator."
        )
        code, out = run(["anchor", "test", "--skip-build", "--validator", "legacy"])
        passing = sum(int(m.group(1)) for m in PASSING.finditer(out))
        failing = sum(int(m.group(1)) for m in FAILING.finditer(out))

    wanted = base["test_count"] + base["new_tests_required"]

    if passing == 0 and failing == 0:
        notes.append(
            "No test results were produced on either validator. `anchor test` "
            "ran but mocha reported nothing — check that your tests are under "
            "tests/, that `yarn install` succeeds, and that `anchor build` "
            "produced target/types/fundraiser.ts for them to import."
        )
    elif failing > 0:
        notes.append(f"{failing} test(s) failing. The suite has to be green.")
    elif passing < wanted:
        notes.append(
            f"{passing} tests passing. The starter ships {base['test_count']}, "
            f"and Checkpoint 6 asks for three more — the happy path, the "
            f"boundary, and the abuse case — so {wanted} is the bar."
        )
    else:
        gates["tests"] = True

    # ── 3 + 4. did the on-chain surface actually change ─────────────────
    idl = json.loads(IDL.read_text())
    instructions, accounts, errors = idl_surface(idl)

    base_ix = {norm(n) for n in base["instructions"]}
    base_accounts = {norm(k): {norm(f) for f in v} for k, v in base["accounts"].items()}
    base_errors = {norm(n) for n in base["errors"]}

    new_ix = sorted(v for k, v in instructions.items() if k not in base_ix)
    new_accounts = sorted(
        label for k, (label, _) in accounts.items() if k not in base_accounts
    )
    new_fields = sorted(
        f"{label}.{written}"
        for k, (label, fs) in accounts.items()
        if k in base_accounts
        for fk, written in fs.items()
        if fk not in base_accounts[k]
    )
    new_errors = sorted(v for k, v in errors.items() if k not in base_errors)

    if new_ix or new_accounts or new_fields:
        gates["surface"] = True
        parts = []
        if new_ix:
            parts.append(f"instructions: {', '.join(new_ix)}")
        if new_accounts:
            parts.append(f"accounts: {', '.join(new_accounts)}")
        if new_fields:
            parts.append(f"fields: {', '.join(new_fields)}")
        notes.append("New on-chain surface — " + "; ".join(parts) + ".")
    else:
        notes.append(
            "The IDL is identical to the starter's: no new instruction, no new "
            "account, no new field. Whatever the feature is, it does not "
            "change any on-chain state, which means there is nothing for a "
            "test to assert on."
        )

    if new_errors:
        gates["errors"] = True
        notes.append(f"New declared error(s): {', '.join(new_errors)}.")
    else:
        notes.append(
            "No new #[error_code] variant. Checkpoint 6's abuse case has to "
            "fail with YOUR error — add one and assert on its code."
        )

    return emit(gates, passing, failing)


def emit(gates: dict, passing: int, failing: int) -> int:
    ordered = ["build", "tests", "surface", "errors"]
    met = sum(1 for g in ordered if gates[g])

    failed = [g for g in ordered if not gates[g]]
    if failed:
        notes.insert(0, "Gates not met: " + ", ".join(failed) + ".")
    notes.append(f"Test suite: {passing} passing, {failing} failing.")

    result = {
        "schema": 1,
        "challenge": CHALLENGE_ID,
        "commit_sha": os.environ.get("GITHUB_SHA", ""),
        "repo": os.environ.get("GITHUB_REPOSITORY", ""),
        "run_id": os.environ.get("GITHUB_RUN_ID", ""),
        # The four gates, in the slot the site already reads. "Every test has
        # to pass" is the right rule here too: a feature that does not build,
        # or has no tests, or changes nothing, is not shipped.
        "canonical": {"passed": met, "total": len(ordered)},
        "reference_check": {"tests_pass_on_correct_program": gates["tests"]},
        "mutation": {"killed": 0, "total": 0, "killed_ids": []},
        "notes": [n for n in notes if n],
    }

    RESULT.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    return 0 if met == len(ordered) else 1


if __name__ == "__main__":
    sys.exit(main())
