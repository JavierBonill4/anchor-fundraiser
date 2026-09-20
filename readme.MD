# Token Fundraiser

This project implements a Solana Anchor-based fundraising program in which contributors send tokens to a campaign vault, the campaign owner tracks the funding progress, and contributors can claim refunds if the fundraising target is not reached before the configured deadline.

The primary focus of this work is not the user interface, but the underlying smart contract design: account state modeling, PDA-based authorization, and validation logic that ensures the program behaves consistently and securely over time.

---

## Setup

You need these installed before running anything:

| Tool | Version |
| --- | --- |
| Anchor | 1.1.2 (`avm install 1.1.2 && avm use 1.1.2`) |
| Solana CLI | 3.1 or newer |
| Node | 20 or newer, with `yarn` |

```bash
yarn install
anchor build
anchor keys sync   # first time only
anchor test
```

One thing that always catches people off guard: this repo has a program ID in the config, but the matching keypair is not included. So the first build creates a fresh program ID, and then the test suite fails with a `DeclaredProgramIdMismatch` error. That is normal. Just run `anchor keys sync` once and rebuild.

This project is basically a fundraiser flow:

- maker creates campaign
- contributors send tokens into vault
- total is tracked on-chain
- target can be checked
- refund is allowed only after the window closes and target was not reached

---

## Main state design

The campaign-wide data lives in one account called `Fundraiser`.
That is the right place for things like:

- target amount
- current amount raised
- campaign start time
- duration
- maker
- mint being raised
- milestone flags

Not on each contributor. Not as random extra state everywhere. Just clean campaign data in one place.

This is the main state:

```rust
#[account]
#[derive(InitSpace)]
pub struct Fundraiser {
    pub maker: Pubkey,
    pub mint_to_raise: Pubkey,
    pub amount_to_raise: u64,
    pub current_amount: u64,
    pub time_started: i64,
    pub duration: u8,
    pub bump: u8,
    pub milestones_fired: u8,
}
```

Important detail: `milestones_fired` is appended at the end. Not inserted in the middle. This matters because Borsh is positional. If you add a field in the middle, every byte after it shifts, and old accounts can deserialize into garbage. That is a silent disaster, and nobody wants that.

So the rule is simple:

- new fields go at the end
- never insert in the middle
- rebuild and re-test after every state change

### Why milestone state is on `Fundraiser`

This is campaign-wide state, not contributor-specific state. The whole fundraiser shares one progress bar. So a single bitmask on `Fundraiser` is the best fit.

The bitmask is basically:

- bit 0 = 25%
- bit 1 = 50%
- bit 2 = 75%

Once a milestone fires, it stays fired. A refund does not undo that. That is the clean design.

---

## Initialize flow

This is the `Initialize` context:

```rust
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        init,
        payer = maker,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump,
        space = ANCHOR_DISCRIMINATOR + Fundraiser::INIT_SPACE,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        init,
        payer = maker,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
```

The important stuff here:

- `maker` pays for the rent and signs the creation
- `fundraiser` is a PDA derived from `[b"fundraiser", maker]`
- `vault` is the ATA owned by the fundraiser PDA
- this is how the program stores the raised funds without using a human wallet as the authority

The actual initialize logic is basically:

```rust
self.fundraiser.set_inner(Fundraiser {
    maker: self.maker.key(),
    mint_to_raise: self.mint_to_raise.key(),
    amount_to_raise: amount,
    current_amount: 0,
    time_started: Clock::get()?.unix_timestamp,
    duration,
    bump: bumps.fundraiser,
    milestones_fired: 0,
});
```

That is it. We validate the target and then save the campaign state.

---

## Contribute flow

Each contributor gets their own account, which stores how much they have contributed so far:

```rust
#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64,
}
```

That is nice and clean because it is per-user data, not campaign data.

Contribution context:

```rust
#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser".as_ref(), fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        init_if_needed,
        payer = contributor,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        space = ANCHOR_DISCRIMINATOR + Contributor::INIT_SPACE,
    )]
    pub contributor_account: Account<'info, Contributor>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = contributor
    )]
    pub contributor_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = fundraiser.mint_to_raise,
        associated_token::authority = fundraiser
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
```

This is the normal pattern:

- one campaign account
- one contributor account per contributor per campaign
- one vault ATA owned by the fundraiser PDA

### What the program checks

The contribute instruction already enforces all the basic rules:

- contribution amount must be at least one whole token
- contribution cannot be more than 10% of target in one go
- contributor total cannot exceed 10% of target
- fundraiser window must still be open

Then it transfers tokens from contributor ATA to vault.

Then it updates:

- `fundraiser.current_amount`
- `contributor_account.amount`

And then milestone logic runs at the end.

---

## Milestone feature

This project uses a milestone bitmask on the fundraiser. The idea is simple:

- 25% reached -> milestone 0
- 50% reached -> milestone 1
- 75% reached -> milestone 2

The key thing is that the program checks the current total after the contribution, and marks all newly reached thresholds that have not fired before.

That means a contribution can jump past multiple milestones in one shot. Example:

- vault was at 20%
- new contribution pushes it to 60%
- then both 25% and 50% should fire if they have not already fired

This is why you do not want three separate `if`s that assume each one runs alone. The correct shape is a loop over thresholds and a bitmask check.

Also, milestones are one-way. They do not un-fire on refund. That is a deliberate choice and it is a valid one.

This is basically staged funding logic. It is a real pattern in fundraising and finance: the campaign is not all-or-nothing from day one; progress unlocks milestones.

---

## Randomness note for SlotHashes idea

If someone tries to use SlotHashes for a draw, we need to be honest: it is not truly fair randomness.

The sysvar gives us some recent slot hashes, but a block producer can still influence what lands in the set and how it is ordered. So yeah, it is okay for a casual raffle or low-stakes gimmick, but it is not something you should pretend is cryptographically fair and tamper-proof.

Basically:

- okay for fun internal mechanics
- not good for anything that needs real fairness
- should be documented honestly in the README instead of being marketed like a secure lottery

---

## The big lesson from state design

This part is the one that actually saves people from pain later.

- campaign-wide flags live on `Fundraiser`
- person-specific data lives on `Contributor`
- new PDA only when the thing has its own lifecycle

And when you add a field:

- append it at the end
- do not insert in the middle
- rebuild after every change

Because Borsh layout is positional. If you insert in the middle, all later fields shift. Your old accounts still deserialize, but they become garbage. That is a silent bug and a nightmare to debug.

So yeah, keep the state append-only and clean.

---

# ORIENTATION

## Read the fundraiser

You are about to add a feature into this program. Put it in the wrong place and you will be fighting it all day.

### Files you need to know

- `state/fundraiser.rs` — campaign-wide account state
- `state/contributor.rs` — per-user contribution amount
- `instructions/initialize.rs` — create campaign + vault
- `instructions/contribute.rs` — money comes in here
- `instructions/checker.rs` — maker claims the pot
- `instructions/refund.rs` — contributor gets money back
- `constants.rs` — named magic numbers
- `error.rs` — custom errors

### The two account patterns

```rust
[b"fundraiser", maker]
[b"contributor", fundraiser, contributor]
```

One fundraiser per maker. One contributor record per person per campaign.

The vault is an associated token account whose authority is the fundraiser PDA. That is the whole trick: a PDA can own a token account, so tokens are held by code instead of by a person.

### What the existing instructions already guard

- initialize refuses a target smaller than 3 whole tokens
- contribute refuses a contribution under 1 whole token
- contribute refuses a single contribution above 10% of target
- contribute refuses a contributor total above 10% of target
- contribute refuses after the window closes
- check_contributions refuses if vault balance is below target
- refund refuses while the window is still open
- refund refuses if target was met

The good part is the symmetry: `contribute` is valid while the window is open, `refund` is valid once it is closed, and they cannot both be legal at the same time. Whatever feature you add, keep that property intact.

### Where the money moves

| Action | From → To | Signed by |
| --- | --- | --- |
| contribute | contributor → vault | contributor keypair |
| check_contributions | vault → maker | fundraiser PDA via seeds |
| refund | vault → contributor | fundraiser PDA via seeds |

If your feature moves or mints anything, it becomes a new row in this table and it will almost certainly be signed by the PDA.

Mark checkpoint 1 complete.

---

# DESIGN

## Choose your feature

Pick one. Not three. One feature, done properly, is way better than three half-baked ones.

This is the main option we picked in this project: milestones at 25%, 50%, and 75%.

### Why this option is good

- no external dependency
- no time-based nonsense in tests
- no crypto/trickery needed
- it fits the existing fundraiser perfectly

The idea is simple: when the vault crosses each threshold, something happens. It can be:

- emit an event for frontend
- unlock part of campaign logic
- record a milestone flag on-chain
- trigger bonus logic or progress updates

The actual feature we implemented is the state + trigger, not some random extra reward system.

The trap to avoid: a single contribution can jump past a threshold. So logic must be based on “what milestones are now fulfilled and not fired yet”, not “did this contribution hit exactly 25% or 50%”.

And one more thing: refund should not un-fire a milestone. That is a deliberate design decision. We keep milestones one-way.

Mark checkpoint 2 complete.

---

# STATE

## Design the state

This is where a feature either stays clean or turns into a whole debugging mess.

### Where it can live

| Place | Good for | Cost |
| --- | --- | --- |
| `Fundraiser` field | campaign-wide stuff | rent once |
| `Contributor` field | per-person data | rent per user |
| new PDA | independent lifecycle | more accounts |

For a milestone bitmask, campaign-wide field on `Fundraiser` is the obvious answer.

### Adding field rule

`#[derive(InitSpace)]` handles the size recalculation automatically. If you add a field, rebuild and the account size updates.

But do not insert it in the middle. Append at the end.

Because Borsh is positional. If you insert in the middle, the layout shifts and old accounts can deserialize into garbage. That is exactly the kind of bug that looks fine in a fresh local test but breaks on real deployed data.

Seeds also matter. Existing patterns are the model:

```rust
[b"fundraiser", maker]
[b"contributor", fundraiser, contributor]
```

That is basically “one X per Y per Z”. Good seeds are clean and unambiguous, and they avoid account collisions.

Check your build after any account change. If something breaks immediately, that is good — it means the issue is visible and fixable right there.

Mark checkpoint 3 complete.

---

# DESIGN

## Pick your moment

Your feature fires at a moment. There are only a few real options:

| Type | What it means | Use when |
| --- | --- | --- |
| Inline | extra logic at the end of an instruction | trigger is caused by an existing action |
| New instruction | someone calls it on purpose | reward claim / settlement |
| Crank | someone has to call it and it checks a condition | time-based or shared trigger |

The main point: programs do not just run on their own. Nothing magically fires at midnight. Somebody has to send a transaction that makes it happen.

For milestones, the best place is inline in `contribute`, right after `current_amount` is updated.

Example shape:

```rust
let quarters = self.fundraiser.current_amount
    .checked_mul(4)
    .ok_or(FundraiserError::Overflow)?
    / self.fundraiser.amount_to_raise;

for i in 0..quarters.min(3) {
    let flag = 1u8 << i;
    if self.fundraiser.milestones_fired & flag == 0 {
        self.fundraiser.milestones_fired |= flag;
    }
}
```

This is the correct idea:

- compute where the total is now
- determine which thresholds are crossed
- only fire those not already fired

Also, integer math in Solana is strict. There are no floats. Multiply before divide, and use `checked_mul` where overflow matters. That is not optional.

And if something should happen only once, you need a flag. A bitmask is perfect for up to 8 tiny events.

Mark checkpoint 4 complete.

---

# BUILD

## Build it

By now, you know the feature, the state, and the trigger moment. This checkpoint is the mechanical part: how to actually code the thing without getting stuck on Anchor basics.

### Adding an instruction

You usually need four edits:

1. a new account struct + impl in `instructions/`
2. `pub mod` and `pub use` in `instructions/mod.rs`
3. a handler in the `#[program]` module in `lib.rs`
4. error variants in `error.rs` with readable `#[msg]`

### Making the PDA sign

If your feature mints, transfers, or closes anything owned by the fundraiser, the fundraiser PDA has to sign for it.

```rust
let signer_seeds: [&[&[u8]]; 1] = [&[
    b"fundraiser".as_ref(),
    self.maker.to_account_info().key.as_ref(),
    &[self.fundraiser.bump],
]];

let cpi_ctx = CpiContext::new_with_signer(
    self.token_program.key(),
    cpi_accounts,
    &signer_seeds,
);
```

This is a super common Anchor gotcha: older tutorials pass `self.token_program.to_account_info()`, but in Anchor 1.0 the function expects the program address — `self.token_program.key()`. If you use the wrong thing, the compiler throws a type mismatch and you end up debugging the wrong error.

### Minting tokens from program

If you do a reward token or NFT receipt, the mint authority has to be the fundraiser PDA, not a person.

```rust
use anchor_spl::token::{mint_to, MintTo};

mint_to(
    CpiContext::new_with_signer(
        self.token_program.key(),
        MintTo {
            mint: self.reward_mint.to_account_info(),
            to: self.contributor_reward_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        },
        &signer_seeds,
    ),
    reward_amount,
)?;
```

If it is a true one-of-one NFT, then set mint authority to `None` after minting. Otherwise it is technically still mintable later, which is not really a one-of-one.

### SlotHashes draw note

If you go for a draw using `SlotHashes`, you have to be honest with yourself: it is not a fair randomness machine. A block producer can influence the set and ordering. So it is okay for a low-stakes game mechanic, not for anything that needs real fairness.

### Events for frontend

If you want the frontend to react, emit an event too:

```rust
#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    pub quarter: u8,
    pub amount: u64,
}

emit!(MilestoneReached { fundraiser: self.fundraiser.key(), quarter, amount });
```

Events are good for listening and UI reactions, but they are not state. On-chain state is still the thing you must trust.

Mark checkpoint 5 complete.

---

# TESTS

## Prove it

This is the part that actually tells you whether the feature works or if it is just vibes.

The test suite should have at least these three kinds of tests:

1. happy path: the feature triggers and state changes as expected
2. boundary case: one unit below the trigger does nothing, exactly at trigger does something
3. abuse case: calling twice or calling without qualification fails with the correct error

Important: a failing test has to fail for the right reason. `try/catch` with only `console.log` is trash because it passes on everything. Even `expect(tx).to.be.rejected` is weak if the transaction fails for some random wrong thing.

The proper pattern is:

```ts
try {
  await program.methods.claimReward()/*. ... */.rpc();
  assert.fail("expected the second claim to be rejected");
} catch (err) {
  assert.strictEqual(err.error.errorCode.code, "RewardAlreadyClaimed");
}
```

This is the correct way: if the second call does not fail, the test fails itself.

### Time-based testing note

`anchor test` cannot move the clock. If your feature depends on time, use `solana-bankrun` instead, because it can set the clock directly.

The pattern is roughly:

```ts
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { Clock } from "solana-bankrun";

const context = await startAnchor("", [], []);
const provider = new BankrunProvider(context);
anchor.setProvider(provider);

const clock = await context.banksClient.getClock();
context.setClock(new Clock(
  clock.slot,
  clock.epochStartTimestamp,
  clock.epoch,
  clock.leaderScheduleEpoch,
  clock.unixTimestamp + 15n * 86_400n,
));
```

Also, Anchor regenerates the IDL on build, so when you add a field in Rust, you can fetch it in TS without manually writing the client model again.

```ts
const account = await program.account.fundraiser.fetch(fundraiser);
assert.strictEqual(account.milestonesFired, 3);
```

If the field is missing or `undefined`, you are probably running stale IDL code. Rebuild.

The last check: comment out your new feature logic and run the suite. At least one test should go red. If everything still passes, your tests are probably describing the old program, not the new one.

Mark checkpoint 6 complete.

---

## Final note

This project demonstrates a straightforward yet important principle in smart contract development: the core value lies not in the complexity of the feature itself, but in the soundness of the state design, the correctness of the seeds and authority model, and the precision of the triggering logic. These elements determine whether the program is maintainable, predictable, and secure in real-world use.

By keeping the state structure deliberate and the execution flow well defined, the fundraiser behaves with greater reliability and clarity. That disciplined design is the real foundation of the project’s success.
