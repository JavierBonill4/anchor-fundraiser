# Token Fundraiser

An on-chain fundraising program built with **Solana + Anchor + SPL Tokens**, extended with **on-chain fundraising milestones at 25%, 50%, and 75%**.

## Overview

A creator (`maker`) opens a fundraiser targeting a set amount of a chosen SPL token. Contributors send tokens into a program-controlled vault. If the target is reached, the maker can claim the funds. If the campaign expires without reaching its target, contributors can claim a refund.

This project extends a base fundraiser implementation by adding milestone tracking that is enforced by the program itself, not just displayed by a frontend.

```
Initialize → Contribute → Track progress → 25% / 50% / 75% reached → Reach target / Refund
```

## Core Accounts

**Fundraiser** (PDA, one per campaign) — the campaign's ledger:
```rust
pub struct Fundraiser {
    pub maker: Pubkey,
    pub mint_to_raise: Pubkey,
    pub amount_to_raise: u64,
    pub current_amount: u64,
    pub time_started: i64,
    pub duration: u8,
    pub bump: u8,
    pub milestones_fired: u8,   // added for this feature
}
```

**Contributor** (PDA, seeded by fundraiser + contributor) — tracks how much each individual has contributed, to enforce per-contributor limits across multiple transactions.

**Fundraiser Vault** — token account controlled by the Fundraiser PDA; contributions flow in here rather than directly to the maker.

## Instructions

- **Initialize** — maker sets a target amount, accepted token mint, and duration; creates the Fundraiser PDA and vault.
- **Contribute** — a contributor sends tokens into the vault. Enforces:
  - minimum contribution of 1 token
  - maximum per-contribution cap of 10% of the target
  - campaign still active (within duration)
  - contributor's cumulative total also respects the cap
- **check_contributions** — if the target is reached, the maker withdraws the vault balance (PDA-signed transfer).
- **Refund** — if the campaign expires below target, contributors withdraw their own contributions back (PDA-signed transfer).

## Milestone System (the added feature)

Progress is tracked in a single extra byte, `milestones_fired`, used as a bitmask:

| Bit | Milestone |
|-----|-----------|
| 0   | 25% reached |
| 1   | 50% reached |
| 2   | 75% reached |

On every contribution, the program recalculates `current_amount` against `amount_to_raise` and checks **which thresholds the new total has crossed that haven't already been recorded** — it does not require a contribution to land exactly on a threshold, and a single large contribution can cross multiple milestones at once.

Each newly crossed milestone:
1. sets the corresponding bit (so it can never fire twice), and
2. emits a `MilestoneReached { fundraiser, milestone, amount }` event for off-chain consumers (frontend/analytics/notifications).

**Milestones are one-way.** If a refund later drops `current_amount` back down, previously recorded milestones are *not* unset — `milestones_fired` is a permanent history of what the campaign achieved, not a live progress gauge.

**Overflow protection.** The threshold check (`current_amount * 4 / amount_to_raise`) uses `checked_mul`, returning an explicit `Overflow` error instead of wrapping silently.

## Design Choices

The milestone feature was kept intentionally minimal:
- no new accounts, no new instructions, no oracles, no external programs, no extra token transfers
- only one new field (`milestones_fired: u8`) on the existing Fundraiser account
- all state is on-chain and program-enforced — a frontend cannot fake or bypass a milestone

## Testing

Tests exercise actual on-chain state transitions (not just transaction success/failure) for a 30-token fundraiser:

| Contribution total      | Expected `milestones_fired` |
| ------------------------ | ---------------------------- |
| 8 tokens (crosses 25%)   | `00000001`                   |
| 15 tokens (crosses 50%)  | `00000011`                   |
| 23 tokens (crosses 75%)  | `00000111`                   |

Run with:
```bash
anchor test
```

## Security & Abuse Cases

**Can a contributor trigger the same milestone twice?**
No. The corresponding bit in `milestones_fired` is set the first time a threshold is crossed, and the program checks that bit before emitting the event or updating state again. Once set, a milestone cannot re-fire.

**Can someone skip a milestone with one large contribution?**
No. The program re-checks all thresholds against the *new total* after every contribution, rather than requiring a contribution to land exactly on 25%/50%/75%. A single contribution that jumps the fundraiser from, say, 15% to 80% will correctly mark all three milestones as reached in one instruction call.

**Can a contributor bypass the per-contribution or per-contributor cap by splitting into multiple transactions?**
No. The Contributor PDA tracks each contributor's cumulative total, so repeated small contributions are checked against the same running total the single-transaction cap enforces.

**Can the frontend fake or spoof a milestone?**
No. `milestones_fired` lives only in the on-chain Fundraiser account and is written exclusively by the program. The `MilestoneReached` event is a notification for off-chain consumers, not the source of truth — a frontend has no way to set it independently.

**What happens to milestone state on refund?**
`current_amount` can drop below a previously crossed threshold once refunds are processed, but `milestones_fired` is intentionally never unset. This is a deliberate design choice: milestones represent a permanent record of what the campaign achieved, not a live/reversible progress bar.

**Can the milestone arithmetic overflow?**
The threshold calculation uses `checked_mul` before dividing; an overflow returns an explicit program error instead of silently wrapping to an incorrect value.

## Running the Project

```bash
yarn install
anchor build
anchor keys sync
anchor build
anchor test
```