# Feature: Reward Token

## What it does

Every contribution mints a proportional amount of a second SPL token — the
"reward" — directly to the contributor, in the same transaction as their
contribution. 1 whole unit of `mint_to_raise` contributed mints exactly
1 whole reward token, regardless of how many decimals either mint uses.
If the campaign fails and a contributor refunds, the reward minted for that
contribution is burned back in the same instruction — a refund is meant to
undo the contribution, and leaving the reward behind wouldn't.

## How it works

**State.** `Fundraiser` is unchanged. `Contributor` gained one field,
appended at the end: `reward_amount: u64` — the program's own record of how
much reward it has minted this contributor, used later to know exactly how
much to burn on refund.

**The reward mint.** Created once, in `initialize`, as a PDA seeded from the
fundraiser's own address (`[b"reward", fundraiser.key()]`) — not a keypair
the maker has to generate and pass to every later instruction. Its decimals
are fixed at `REWARD_DECIMALS = 9` (`constants.rs`), deliberately different
from `mint_to_raise`'s decimals in every test in this repo, so the decimals
conversion below is exercised on every single contribution rather than only
in a special-cased test. The **fundraiser PDA** (not the reward mint's own
PDA — a mint can't sign for itself) is set as mint authority, so only this
program, signing with the fundraiser's seeds, can ever mint from it.

**The decimals conversion — the trap this feature is built around.** A raw
contribution amount is denominated in `mint_to_raise`'s decimals. Minting
that same raw integer into a mint with *different* decimals mints the wrong
number of reward tokens — silently, with no error, no matter how the two
mints relate. `contribute` converts through a common scale instead:

```rust
let reward_amount: u64 = (amount as u128)
    .checked_mul(reward_scale as u128)   // multiply first
    .ok_or(FundraiserError::Overflow)?
    .checked_div(raise_scale as u128)    // ...then divide
    .ok_or(FundraiserError::Overflow)?
    .try_into()
    .map_err(|_| FundraiserError::Overflow)?;
```

Multiply-before-divide, in `u128` so a large contribution times a `10^9`
scale can't overflow mid-calculation, with every step `checked_*` and
mapped to a named error rather than left to panic or wrap.

**Where it fires.** Inline, at the end of `contribute`, after the existing
transfer succeeds and before the fundraiser/contributor state updates. Also
inline, at the end of `refund`, is the burn — CPI'd with the *contributor's
own signature*, not the PDA's, since they (not the program) own their reward
token account.

**The four accounts, and who signs.**

| Where | Action | Signed by |
|---|---|---|
| `contribute` | mint reward → contributor's reward ATA | fundraiser PDA, by seeds |
| `refund` | burn reward from contributor's reward ATA | the contributor's own keypair |

## What it costs

- **Rent:** one new mint account (created once per campaign, paid by the
  maker in `initialize`) plus one reward-token ATA per contributor
  (`init_if_needed`, paid by the contributor on their first contribution —
  the standard ATA rent-exempt minimum, refunded to no one since ATAs aren't
  closed here).
- **Compute:** `contribute` gains one CPI (`mint_to`) and a handful of
  checked u128 operations. `refund` gains one CPI (`burn`), only when
  `reward_amount > 0`. Neither is expensive relative to the existing
  transfer CPI already in both instructions.
- **Accounts:** `contribute` and `refund` each gained two required accounts
  (`reward_mint`, `contributor_reward_ata`).

## How I would attack it

**The real one: refund can soft-lock a contributor who no longer holds their
reward.** Reward tokens are ordinary, transferable SPL tokens. If a
contributor sends them elsewhere — sells them, trades them, anything — and
the campaign then fails, `refund`'s burn CPI fails with an insufficient-funds
error from the token program, and the *entire* refund transaction reverts
with it, including the part that would have returned their original
contribution. They cannot get their money back until they reacquire enough
reward tokens to satisfy the burn. I chose this over the alternative (skip
the burn if the balance is short, and let them keep the refund plus whatever
reward they didn't manage to spend) because that alternative reopens the
exact double-dip this feature exists to close, just gated on being fast
enough to move the tokens first. A production version would probably make
the reward mint non-transferable (a frozen account, or a check in `transfer`
hooks — Token-2022 territory) to remove the trade-off entirely rather than
document it; that was out of scope here.

**Smaller ones, both handled but worth naming:**

- *Front-loading the reward before the campaign fails.* This is exactly the
  trap the burn-on-refund closes, tested directly in
  `tests/time-window-bankrun.ts` ("refund must burn back the reward minted
  for the refunded contribution").
- *Precision loss at the low end.* The `checked_div` truncates. A
  contribution of, say, `1_000_001` raw units (just over the 1-token minimum)
  against a reward mint with fewer decimals than the raise mint could round
  down to a reward of 0 for the remainder. Not exploitable — nobody gains
  from truncation working against them — but worth knowing the reward is a
  floor, not an exact mirror, of the contribution.

## Testing

`anchor test` — the original suite's account lists were updated to pass the
two new required accounts (`reward_mint`, `contributor_reward_ata`) so the
existing instructions still work end to end. New assertions:

- **Happy path** (`tests/fundraiser.ts`): a 1-token contribution against a
  6-decimal raise mint and a 9-decimal reward mint mints exactly
  `1_000_000_000` raw reward units — the number that's only right if the
  decimals conversion is correct, not the naive `1_000_000` a same-raw-unit
  mint would produce.
- **Boundary**: a second, smaller (1.5-token) contribution mints a
  proportionally smaller reward and accumulates correctly on top of the
  first.
- **Abuse case** (`tests/time-window-bankrun.ts`): a contributor who burns
  away their reward tokens before the deadline cannot cleanly refund
  afterward — the program's burn-back fails for lack of balance, and the
  whole refund reverts. This is the documented trade-off above, proven to
  actually happen rather than just asserted in prose.
