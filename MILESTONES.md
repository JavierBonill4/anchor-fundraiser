# Milestones (custom feature, Week 3 Day 2)

Option A from the guide: fire something at 25%, 50% and 75% of the target.

## What it does

A campaign now keeps a record of how far it has ever got. The moment the vault
total crosses a quarter, a half or three quarters of the target, the program
records that mark and emits an event. The maker can then announce each recorded
mark to the world exactly once.

Nothing about the money changes. `initialize`, `contribute`, `check_contributions`
and `refund` move the same tokens they moved before, under the same rules — the
feature only observes, records, and adds one new instruction of its own.

## How it works

**State.** Two bytes on `Fundraiser`, sixteen bits of which three are used:

| Field | Meaning |
| --- | --- |
| `milestones_reached: u8` | bit *i* is set once the campaign has ever touched `MILESTONE_PERCENTS[i]` |
| `milestones_announced: u8` | bit *i* is set once the maker has announced milestone *i* |

`MILESTONE_PERCENTS` is `[25, 50, 75]`, so index 0 is the quarter mark. Adding a
fourth mark is one entry in that array; nothing else changes.

**Where it fires.** At the very end of `contribute`, after `current_amount` and
the contributor's running total have been written. It reads the totals the base
instruction just produced, so it cannot change whether a contribution is
accepted — if the transfer or any earlier check fails, the whole transaction
reverts and no bit is set.

**The loop.** Every unset bit is retested on every contribution:

```rust
for (index, percent) in MILESTONE_PERCENTS.iter().enumerate() {
    let bit = 1u8 << index;
    if fundraiser.milestones_reached & bit != 0 { continue; }
    let threshold = target.checked_mul(*percent as u128)?;
    if scaled_raised >= threshold { fundraiser.milestones_reached |= bit; emit!(..) }
}
```

This is the trap the guide warns about. A contribution may be up to 10% of the
target, so the total moves in jumps and "one mark per contribution" is wrong. A campaign sitting at 70% that receives
10% lands at 80% and crosses 75% in a single call; a campaign that somehow went
from 0 to 80% would set all three bits in one pass.

**The arithmetic.** The test is `raised * 100 >= percent * target`, computed in
`u128`. No division, so no rounding; no floats anywhere; every multiplication is
`checked_mul`. Widening to `u128` first means a `u64` target near the type's
ceiling cannot overflow the comparison.

**The new instruction.** `acknowledge_milestone(index: u8)` takes the maker as a
signer and the fundraiser PDA, and refuses four ways:

| Case | Error |
| --- | --- |
| index outside the table | `InvalidMilestone` |
| the mark has not been reached | `MilestoneNotReached` |
| the mark was already announced | `MilestoneAlreadyAnnounced` |
| the signer is not this campaign's maker | `ConstraintSeeds` (Anchor 2006) |

The announcement is the part that must fire once, so it has its own flag byte
rather than reusing the reached bits. `has_one = maker` plus seeds derived from
the maker's key means a stranger cannot pass someone else's fundraiser.

## What it costs

- **Rent:** two extra bytes on the `Fundraiser` account. At the current rate,
  under 0.000015 SOL, paid once by the maker at `initialize`. No new accounts,
  no new PDAs, nothing to close.
- **Compute inside `contribute`:** a three-iteration loop over `u128` compares,
  plus one event per newly crossed mark. Small next to the token CPI that
  dominates the instruction.
- **`acknowledge_milestone`:** one account load and one byte written.
- **Failure modes:** none added to the money path. The hook only writes a flag.

## How you would attack it

**The bits latch, and that is a deliberate choice.** A refund lowers
`current_amount`, but never clears a reached bit. So a campaign can advertise
"we hit 50%" while the vault sits below half. The alternative — recomputing the
bits on refund — is worse: it would let a contributor toggle a mark off and on,
and an announcement already made cannot be unmade anyway. The honest reading of
`milestones_reached` is "the high-water mark this campaign has ever touched",
and the README says so rather than the field name pretending otherwise.

**A maker can manufacture their own milestones.** Nothing stops the maker from
contributing to their own campaign from a second wallet, crossing 25% with their
own money, announcing it, and getting the refund later if the campaign fails.
The cost is the 10% per-contributor cap and the rent, not much. Any milestone
used as a social signal should be read with that in mind. Fixing it properly
means excluding the maker's own contributions, which needs a check the base
`contribute` does not have.

**Announcements are cosmetic.** `milestones_announced` gates an event, not
money. If a later version pays out on a milestone, the latch above becomes a
real exploit: reach 75% with friendly money, take the payout, let the refunds
run. That version would need the bits recomputed against the live vault balance
at payout time, not against a stored flag.

**Events are not durable.** `emit!` writes to the transaction log, which RPC
providers prune. The bits on the account are the source of truth; the events are
a convenience for an indexer that is listening at the time.

## Tests

`tests/milestones-bankrun.ts`, four cases. All of them fail without the feature —
the fields and the instruction do not exist on the base program.

1. **Happy path** — seven contributions of 10% set bits 0 and 1 and leave bit 2
   clear at 70%; the eighth crosses 75% in one call. Asserts the whole byte, and
   that announcing changes no reached bit.
2. **Boundary** — a campaign one raw unit below 25% has no bit set; a campaign
   sitting exactly on 25% has bit 0 and only bit 0. (Two campaigns, because
   the base `contribute` refuses anything under one whole token, so a single
   raw unit cannot be added on its own.)
3. **Abuse** — an unreached mark, an out-of-range index, a stranger, and a second
   announcement, each asserted against its named error, with the flag byte
   checked afterwards to prove the failures wrote nothing.
4. **The latch** — reaches exactly 25%, fast-forwards the bankrun clock past
   the deadline, refunds one 10% contributor, and asserts the total fell to 15%
   while bit 0 stayed set. This is the "refunds move the total back down" half
   of the trap, exercised rather than described.

Every contribution in the tests comes from a fresh wallet: the base program caps
each contributor at 10% of the target *in total*, so one wallet can never walk a
campaign past a milestone on its own.

**Result:** `anchor test` on GitHub Actions (Anchor 1.1.2, Agave validator) —
15 passing, 0 failing: the 11 original tests plus these 4.
