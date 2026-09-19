# Token Fundraiser

## Prerequisites

| Tool | Version |
| --- | --- |
| Anchor | 1.1.2 (`avm install 1.1.2 && avm use 1.1.2`) |
| Solana CLI | 3.1 or newer |
| Node | 20 or newer, with `yarn` |

```bash
yarn install
anchor build
anchor keys sync   # first time only — see below
anchor test
```

The repo declares a program id it does not ship the keypair for, so your first
`anchor build` generates a different one and `anchor test` fails with
`DeclaredProgramIdMismatch`. `anchor keys sync` rewrites `declare_id!` and
`Anchor.toml` to match the keypair you just generated. Run it once, then rebuild.

This example demonstrates how to create a fundraising for SPL Tokens.

In this example, a user will be able to create a fundraiser account, where he will be specify the mint he wants to collect and the fundraising target.

# Reward Token (Option D)

## What it does

When you contribute to a fundraiser, you also get **reward tokens** for that fundraiser.

- Contribute 1 token, get 100 reward tokens.
- If the fundraiser **fails** and you take your refund, your reward tokens are **burned** (destroyed). You don't get paid for a contribution you took back.
- If the fundraiser **succeeds**, you keep your reward tokens.

## How it works

**The reward token**
- Each fundraiser gets its own reward token, created in `initialize`.
- Its address is a PDA made from `["reward", fundraiser]`.
- The fundraiser PDA is the only one allowed to mint it, so nobody can print rewards by hand.
- It has 9 decimals. The rate (100 per token) and decimals live in `constants.rs`.

**New state** (both added at the *end* of the account, so nothing shifts)
- `Fundraiser.reward_mint`: which reward token belongs to this campaign.
- `Contributor.rewards_minted`: how many reward tokens this wallet was given. Refund burns exactly this amount.

**Contribute** (all original checks first, then):
1. Work out the reward.
2. Update the counters.
3. Move the contributor's tokens into the vault.
4. Mint the reward to the contributor's reward token account (created if it doesn't exist yet).

**Refund** (after the original checks):
1. Check the wallet still holds at least `rewards_minted`. If not, fail with `RewardsNotHeld`.
2. Burn those rewards.
3. Send the money back. The contributor account closes, so this can only happen once.

**The math**
```
reward = amount × 100 × 10^9 ÷ 10^(decimals of the raised token)
```
- Uses `u128` and `checked_*` so it can't overflow. No floats.
- Multiplies first and divides last, so small amounts don't round to zero.
- Rounds **down**, so the program never mints more than it owes.
- Example: 1 USDC (6 decimals) gives exactly 100 reward tokens.

**Why burn on refund, and not "claim after success"?**
When the target is met, `check_contributions` empties the vault and closes the fundraiser. After that, nothing on-chain can prove the campaign succeeded, so a claim step would have nothing to check. Burn-on-refund works with the four original instructions unchanged.

## What it costs

| Who pays | What | About |
|---|---|---|
| Maker | Reward token account (82 bytes) | 0.00146 SOL |
| Maker | 32 extra bytes on `Fundraiser` | 0.00022 SOL |
| Contributor | Reward token account (165 bytes), first contribution only | 0.00204 SOL |
| Contributor | 8 extra bytes on `Contributor` | 0.00006 SOL |

**Extra compute:** one `mint_to` call on contribute (plus creating the token account on a wallet's first contribution) and one `burn` call on refund.
Measured: contribute ___ CU, refund ___ CU. *(fill in from the `anchor test` logs)*

## How I would attack it

| Attack | Result |
|---|---|
| Move the rewards to another wallet, then refund to keep both | **Blocked.** Refund fails with `RewardsNotHeld` (test 3). |
| Mint reward tokens directly | **Blocked.** Only the fundraiser PDA is the mint authority (test 4). |
| Pass a fake reward token | **Blocked.** `has_one` fails with `InvalidRewardMint`. |
| Contribute, refund, contribute again to farm rewards | **Blocked.** Contribute only works while the window is open, and refund only after it closes. |
| Overflow or rounding tricks | **Blocked.** Checked `u128` math, rounds down, and refund burns the saved total. |
| Contribute an amount too small to earn anything | **Blocked.** Minimum is 1 whole token, plus a `RewardTooSmall` check. |

**Weak points I know about:**
- **Reward tokens can be sent to anyone.** If you sell or send them away, you can't refund until you get them back. That is the price of this design. A non-transferable token (Token-2022) would fix it, but it is out of scope.
- **One campaign per maker.** The vault account is never closed (this was already true before my change), so a maker can't reuse the same setup. My reward token has the same limit.
- **Refund needs the rewards in the original reward token account.** If they sit in a different account, move them back first.

## Tests

`tests/reward-token.ts` (bankrun, so the clock can move past the deadline):

1. **Happy path:** contributing 1 token mints exactly 100 rewards, and state matches.
2. **Boundary:** 1 unit under the minimum fails and mints nothing. Exactly 1 token mints exactly 100.
3. **Abuse:** refund fails with `RewardsNotHeld` if the rewards were moved. After returning them, refund works and the reward supply drops to 0.
4. **Abuse:** a contributor can't mint rewards directly.

Run them with:
```
anchor build
anchor test
```