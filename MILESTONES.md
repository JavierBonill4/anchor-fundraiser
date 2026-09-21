# Feature: Milestones

## What it does

Every `Fundraiser` account now tracks which funding milestones it has
reached, as a `u8` bitmask on a new `milestones` field:

| Bit | Milestone |
|-----|-----------|
| 0   | 25% of `amount_to_raise` reached |
| 1   | 50% of `amount_to_raise` reached |
| 2   | 75% of `amount_to_raise` reached |

The mask is recomputed — not incrementally patched — on every successful
`contribute` and every successful `refund`, so it is always an exact,
current snapshot of `current_amount / amount_to_raise`, never a stale
approximation.

## How it works

All of the logic lives in one pure function, `Fundraiser::milestones_for`:

```rust
pub fn milestones_for(current_amount: u64, amount_to_raise: u64) -> Result<u8> {
    const MILESTONE_PERCENTAGES: [u64; 3] = [25, 50, 75];
    let mut bits: u8 = 0;
    for (i, pct) in MILESTONE_PERCENTAGES.iter().enumerate() {
        let threshold = amount_to_raise
            .checked_mul(*pct)
            .ok_or(crate::FundraiserError::MilestoneOverflow)?
            / 100;
        if current_amount >= threshold && threshold > 0 {
            bits |= 1 << i;
        }
    }
    Ok(bits)
}
```

Both `contribute` and `refund` call this exact function, passing their own
post-update `current_amount`, and overwrite `fundraiser.milestones` with
whatever it returns:

```rust
self.fundraiser.milestones = Fundraiser::milestones_for(
    self.fundraiser.current_amount,
    self.fundraiser.amount_to_raise,
)?;
```

This is the whole design decision: **one function decides the mask in
both directions.** `contribute` only ever increases `current_amount`, so
calling the function afterward can only add bits. `refund` only ever
decreases it, so calling the function afterward can only remove bits.
Neither instruction contains its own copy of the threshold logic, so
there is no way for the two to drift out of sync with each other — a
bug in the shared function shows up identically in both directions
instead of manifesting as an inconsistency between them.

## The trap this avoids

A more naive implementation is tempting: in `contribute`, check "did we
just cross 25%? set bit 0"; in `refund`, check "did we just drop below
25%? clear bit 0." This requires writing the threshold comparison twice,
once per direction, and it is easy for the two copies to disagree —
for example, one using `>` and the other using `>=`, or one comparing
against the pre-update amount and the other against the post-update
amount. Recomputing from scratch every time removes the class of bug
entirely: there is only one comparison to get right, and it is used
identically everywhere.

## What it costs

- **Storage:** 1 extra byte per `Fundraiser` account (`u8`), automatically
  accounted for by `#[derive(InitSpace)]` — no manual `space =` math to
  keep in sync.
- **Compute:** three integer divisions and up to three comparisons per
  `contribute` or `refund` call — negligible next to the CPI cost already
  paid by both instructions (each does at least one SPL token transfer).
- **No new accounts, no new CPIs, no new mints.** The feature is entirely
  a computation over data that was already being written.

## How this could be attacked

**Overflow.** `amount_to_raise.checked_mul(75)` can overflow `u64` if
`amount_to_raise` is large enough (roughly `u64::MAX / 75`, about
2.46 × 10^17). Rather than silently wrapping or panicking, the checked
multiplication surfaces this as `FundraiserError::MilestoneOverflow`,
rejecting the contribution outright. Tested directly: a fundraiser with
`amount_to_raise = 3 × 10^17` accepts contributions fine for the 10%
per-wallet cap check (`× 10` stays under `u64::MAX`) but rejects them at
the milestone check (`× 75` overflows) — proving the milestone-specific
overflow, not a general one, is what's being caught.

**Bit-skipping.** Because `MAX_CONTRIBUTION_PERCENTAGE` limits any single
wallet to 10% of the total, no single contribution can skip a milestone
by itself (jumping from under 25% straight past 50% would require a
single contribution over 25%, which the existing cap forbids). Multiple
contributors *can* collectively cross more than one milestone in a
single contribution's aftermath — this is intended and tested (crossing
both 25% and 50% via several 10%-capped contributions). It is not
exploitable: it just means large collective progress correctly sets
every bit that's genuinely been earned, not more.

**Refund draining.** Since `refund` recomputes the mask from the new,
lower `current_amount`, refunding contributors after a milestone is hit
correctly clears bits as the total falls back below each threshold.
This is tested explicitly: two contributors cross 25% and 50%, the
window closes with the target unmet, both refund, and the mask returns
to `0` — proving milestones don't "stick" once earned if the money
actually leaves the vault.

## Tests

`tests/milestones.ts`, four cases:

1. `sets both the 25% and 50% bits once total contributions cross 50%,
   but not 75%` — happy path, multiple contributors, asserts the exact
   bitmask.
2. `sets the 25% bit only once the total reaches exactly the threshold,
   not one token before` — boundary test at 1-token granularity, proves
   `>=` semantics.
3. `rejects a contribution to a fundraiser whose target would overflow
   the milestone math` — abuse/overflow test, asserts the specific named
   error `MilestoneOverflow`.
4. `clears milestone bits on refund, symmetric with how contribute sets
   them` — the trap test: crosses two milestones, closes the window,
   refunds every contributor, asserts the mask returns to zero.

All four require `solana-bankrun` (via `anchor-bankrun`) rather than a
live validator, since test 4 needs to fast-forward past the fundraiser's
deadline to legally call `refund`.
