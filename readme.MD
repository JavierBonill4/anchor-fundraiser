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

---

# The lottery

## What it does

Backing a campaign buys raffle tickets, one per raw token, and if the campaign
succeeds one ticket wins the money raised above the target.

The maker is paid exactly the amount they asked to raise — never more. Whatever
came in above the target is the prize, so the lottery is funded by money the
maker was never owed, and no backer is worse off than under the original
program.

## How it works

### State

Appended to `Fundraiser` (appended, never inserted — Borsh reads by position):

| field | type | set by |
| --- | --- | --- |
| `total_tickets` | `u64` | `contribute`, running total and allocation cursor |
| `winning_ticket` | `u64` | `check_contributions` |
| `drawn` | `bool` | `check_contributions`, fires once |

Appended to `Contributor`:

| field | type | meaning |
| --- | --- | --- |
| `ticket_start` | `u64` | first ticket number owned |
| `ticket_end` | `u64` | one past the last — the range is half open |

`total_tickets` is kept separate from `current_amount` even though the two hold
the same number today. `refund` decrements `current_amount`; tickets must not be
un-issued, because that would punch holes in the numbering that no account could
ever prove ownership of.

### Why ranges

A Solana program cannot enumerate accounts. There is no way to loop over every
`Contributor` PDA and pick one, and holding an entrant list on `Fundraiser`
would mean reallocating the account on every contribution.

Ranges invert the search. Each contribution takes the next contiguous block of
ticket numbers, so the program only has to store one running counter and two
numbers per backer. The draw picks a number and stops; the winner comes forward
with their own `Contributor` account and the program checks the number falls
inside it. The program never learns who won.

A repeat contribution can only *extend* a range, and only while it is still the
last one handed out. Overwriting it would orphan the earlier tickets and the
draw could land on a number nobody could claim, so a non-contiguous top-up is
rejected with `NonContiguousTickets` and the backer keeps what they already
bought.

### Where it fires

Inline in `check_contributions`, plus one new instruction.

`check_contributions()` — maker only, unchanged signature and trigger. It now
also rejects a second call (`AlreadyDrawn`), requires at least one ticket
(`NoTicketsIssued`), records `winning_ticket`, and pays the maker
`amount_to_raise` instead of the whole vault.

`claim_prize()` — new. The holder of the winning ticket passes their own
`Contributor` account; the program checks
`ticket_start <= winning_ticket < ticket_end` and moves the remaining vault
balance to them.

**One behaviour change worth flagging.** `check_contributions` used to close the
`Fundraiser` account. It cannot any more: the winning number has to survive
until someone claims, and the PDA is the vault's authority. `claim_prize` closes
it instead, so the maker still gets the rent back, just one step later.

**Two guards the original program got for free.** `check_contributions` used to
close the `Fundraiser` account, and that closure was quietly doing two jobs
nobody had to name: it made a post-settlement `contribute` impossible, and it
made a post-settlement `refund` impossible. The account has to survive now, so
both are written out explicitly.

- `contribute` refuses once `drawn` is set. This is what the closure used to do
  implicitly — a missing `Fundraiser` account failed the instruction — so the
  behaviour is unchanged, only the error is now a named one. Without it, tickets
  bought after the draw could never win and the money would silently inflate the
  prize the already-decided winner collects.
- `refund` refuses once `drawn` is set. Settlement leaves the vault holding only
  the prize, which is below the target — and "below the target" was exactly what
  `refund` tested, so before the tally change every contributor could have
  drained the prize one refund at a time once the deadline passed. Reading
  `current_amount` closes that path on its own, since settlement does not
  decrement it, but that is a property of how settlement happens to be written.
  The flag states the rule directly: a settled campaign is not refundable.

**Success and failure are now decided by `current_amount`, not the vault
balance.** The vault is an ordinary token account that anyone can transfer into.
Settling on the balance let a maker top up a short campaign and be paid the full
target out of real contributions; the mirror case let a stranger push a failed
campaign's vault over the line and block every refund. Both gates read the
program's own tally instead — the number `contribute` and `refund` actually
maintain.

### The draw

```
slot_hash = SlotHashes[0]                   // newest completed slot, bytes 16..48
entropy   = u64::from_le_bytes(slot_hash[0..8])
winner    = entropy % total_tickets
```

The slot hash is the entropy. It is the only value available on chain that is
unpredictable while contributions are still open, which is the property that
matters most here: a backer who could compute the winning number before
contributing could then choose an amount that puts their own range around it.
Find `X` such that `entropy % (total + X)` lands in `[total, total + X)` — the
search is cheap, so any scheme whose entropy is fixed before the ticket set is
frozen hands the campaign to whoever notices.

The slot hash closes that. It does not close the other end of the problem, and
the attack section below says so plainly.

The sysvar is read as raw bytes and pinned by address: it is about 20 KB, so
deserializing it properly would cost more compute than the rest of the
instruction put together. The hash is already a uniform digest, so it is used
directly rather than run through sha256 again.

## What it costs

### Rent

Rent-exempt minimum is `(128 + bytes) * 6960` lamports.

| account | before | after | delta |
| --- | --- | --- | --- |
| `Fundraiser` | 98 B — 0.001573 SOL | 115 B — 0.001691 SOL | **+0.000118 SOL**, once per campaign |
| `Contributor` | 16 B — 0.001002 SOL | 32 B — 0.001114 SOL | **+0.000112 SOL**, per backer |

A campaign with 100 backers pays about 0.0113 SOL more than before. No new
accounts are created: the feature rides entirely on accounts the original
program already opened.

### Compute

Measured on `solana-bankrun` against the built program. Ranges cover the cheap
path (account already exists) and the expensive one (an associated token account
is created inside the instruction).

| instruction | CU |
| --- | --- |
| `initialize` | 34,817 – 46,817 |
| `contribute` | 24,433 – 43,560 |
| `check_contributions` | 18,062 – 72,799 |
| `claim_prize` | 18,991 – 32,433 |
| `refund` | 25,281 |

For reference the unmodified program used 39,100 CU for `initialize` and 26,732
for `contribute`, so ticket allocation is lost in the noise — it is two `u64`
writes and a comparison. The draw itself is a 32 byte copy out of the sysvar and
one modulo.

## How you would attack it

### 1. The maker can re-roll by not settling — this one is real and unfixed

`check_contributions` is maker-only. At the moment the maker builds the
transaction they can already read the slot hash the program is about to use, so
they can compute the winner before signing. If they do not like the answer they
simply do not send. Four hundred milliseconds later the newest slot hash has
changed and they can compute again. A transaction that is never broadcast costs
nothing, and there is no deadline forcing settlement.

This is not limited to winning it themselves. `total_tickets` is frozen once the
window closes, so each new slot is an independent uniform draw over the whole
ticket space, and the maker can wait for **any** outcome they want. To hand the
prize to a range of width `w` they expect `total_tickets / w` attempts:

| range held | expected slots | wall clock |
| --- | --- | --- |
| 10% (the per-contributor cap) | 10 | ~4 s |
| 1% | 100 | ~40 s |
| 0.1% | 1,000 | ~7 min |

So the honest description is: **the maker chooses the winner, and it costs them
a few seconds of waiting.** The only thing pushing back is that their own money
sits in the vault until they settle.

It is worth being clear that the assignment's other suggestion does not fix
this. Committing `hash(secret)` at `initialize` and revealing at settlement
moves the lever rather than removing it: the maker holds the secret, so with
secret-only entropy they can compute the winner *during* the campaign and buy a
range around it, which is strictly worse. Mixing the secret into the slot hash
blocks that, but leaves the re-roll above completely intact, because the maker
holds both halves. It buys one thing — it blinds the validator in point 2 — and
that did not seem worth a 32 byte commitment field and an extra argument.

What actually closes it is structural, not a better entropy source: split the
draw into a commitment to slot `N + k` and a settlement that must use the hash
of that specific slot. At commit time the hash does not exist, so nothing can be
computed; at settlement time the hash is already determined, so nothing can be
re-rolled. That is a second instruction, a second round trip, and a new failure
mode when the committed slot ages out of the 512-entry sysvar window. It is not
implemented here.

### 2. Leader grinding

The validator producing the slot whose hash is used chooses which transactions
go into the block and in what order, and the proof-of-history chain mixes those
contents in. Within the slot they can try several orderings and keep the one
they prefer.

Every input to the draw is public, so unlike point 1 this one is *targeted*: the
leader can work out exactly which candidate hash makes a chosen backer win. The
countermeasure would be to mix in a value the leader does not know — the
maker's committed secret does exactly that — but see above for why that trade
was not taken.

### 3. Settling early ends ticket sales early

`check_contributions` has no deadline check and never had one: it fires as soon
as the target is met, which may be day one of a seven day campaign. Backers who
meant to enter before the advertised deadline are then turned away.

This is inherited, not introduced. The original program closed the `Fundraiser`
on settlement, and `contribute` requires that account, so settlement already
ended contributions — just with an `AccountNotInitialized` rather than a named
error. The `drawn` guard reproduces the old behaviour on an account that now has
to survive.

It is still a lever the maker holds, and the lottery gives them a reason to use
it: settling early freezes a ticket set they can see. Requiring the deadline
before settling would remove it, at the cost of making the maker wait for money
they have already raised.

### 4. Sybil beats the contribution cap

`MAX_CONTRIBUTION_PERCENTAGE` bounds one address at 10% of the target and
therefore at roughly a 10% chance of winning. Nothing stops one person from
using ten wallets and taking the whole prize. The cap predates this feature, but
the lottery gives it something to be worth attacking for. It also makes point 1
cheaper: a bigger range means fewer slots to wait.

### 5. An unclaimed prize strands the rent

`claim_prize` is what closes the `Fundraiser`. If the winner never comes forward
— lost keys, lost interest — the prize and the account's rent stay where they
are forever. Forfeiting after a deadline would free the rent but would take real
money from someone who was merely slow, so nothing was added.

The incentive is at least aligned: claiming also closes the winner's own
`Contributor` account and returns its 0.00111 SOL, so the call pays for itself
even on a campaign that landed exactly on target and left no prize at all.

### 6. Modulo bias

`entropy % total_tickets` is not perfectly uniform: 2^64 is not a multiple of the
ticket count, so the lowest numbers are very slightly favoured. The skew is on
the order of `total_tickets / 2^64`, around 1e-12 for a realistic campaign, and
is ignored deliberately rather than by oversight.

### 7. Ticket numbers are chosen, not random

`ticket_start` is the current `total_tickets`, which anyone can read before
sending. A backer knows exactly which numbers they are buying and can set the
width by choosing the amount. That is harmless only because the winning number
is not computable at contribute time — which is the single job the slot hash is
doing.

### Pre-existing problems the feature does not fix

Worth naming because they now guard a prize:

- Nothing ever closes the vault ATA, so about 0.00204 SOL per campaign sits
  there. Recoverable in principle — a PDA can sign for an account that no longer
  exists, and the canonical bump can be re-derived — but no instruction does it.
- `Fundraiser` is seeded by the maker alone, so a maker can only ever run one
  campaign: after a success the vault ATA blocks the next `initialize`, and after
  a failure the `Fundraiser` account does. Verified against both paths.
- `refund` relies on `close = contributor` as its only double-spend guard.
  `claim_prize` ends up in the same shape, because it closes the `Fundraiser` it
  needs; that is sound while the account is a required input, and where an account
  survives its instruction the guard is an explicit `drawn` flag instead.
- Closing the `Fundraiser` on the claim leaves every non-winning `Contributor`
  PDA with no route out, since `refund` is the only thing that closes one and it
  needs the campaign account. Another 0.00111 SOL per backer. A dedicated cleanup
  instruction would collect both this and the vault; there is not one.

## Tests

`tests/lottery.ts`, nine cases on `solana-bankrun`, on top of the eleven the
starter ships.

| case | asserts |
| --- | --- |
| contiguous ranges | every range begins where the previous ended, width equals the contribution |
| happy path | the draw fires, the number is in range, the maker receives exactly the target, the winner receives the overshoot, the campaign closes |
| boundary | both neighbours share an edge with the winning range and both are refused with `NotWinningTicket` |
| refund after settlement | `AlreadyDrawn`, and the prize is untouched |
| contribution after the draw | `AlreadyDrawn` |
| double draw | `AlreadyDrawn` |
| claim before draw | `NotDrawn` |
| contiguous top-up | the existing range widens rather than being replaced |
| non-contiguous top-up | `NonContiguousTickets`, earlier tickets untouched |

Deleting the draw makes the happy path, the boundary case and the double-draw
case fail, so the feature is provably present.

---

## Let's walk through the architecture:

A fundraising account consists of:

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
}
```

### In this state account, we will store:

- maker: the person who is starting the fundraising

- mint_to_raise: the mint that the maker wants to receive

- amount_to_raise: the target amount that the maker is trying to raise

- current_amount: the total amount currently donated

- time_started: the time when the account was created

- duration: the timeframe to collect all the contributions (in days) 

- bump: since our Fundraiser account will be a PDA (Program Derived Address), we will store the bump of the account

We use InitSpace derive macro to implement the space triat that will calculate the amount of space that our account will use on-chain (without taking the anchor discriminator into consideration)

---

### The user will be able to create new Fundraiser accounts. For that, we create the following context:

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

Let´s have a closer look at the accounts that we are passing in this context:

- maker: will be the person starting the fundraising. He will be a signer of the transaction, and we mark his account as mutable as we will be deducting lamports from this account

- mint_to_raise: The mint that the user wants to receive. This will be a Mint Account, that we will use to store the mint address

- fundraiser: will be the state account that we will initialize and the maker will be paying for the initialization of the account.
We derive the Fundraiser PDA from the byte representation of the word "fundraiser" and the reference of the maker publick key. Anchor will calculate the canonical bump (the first bump that throes that address out of the ed25519 eliptic curve) and save it for us in a struct

- vault: We will initialize a vault (ATA) to receive the contributions. This account will be derived from the mint that the user wants to receive, and the fundraiser account that we are just creating

- system_program: Program resposible for the initialization of any new account

- token_program and associated_token_program: We are creating new ATAs

### We then implement some functionality for our Initialize context:

```rust
impl<'info> Initialize<'info> {
    pub fn initialize(&mut self, amount: u64, duration: u8, bumps: &InitializeBumps) -> Result<()> {

        // Check if the amount to raise meets the minimum amount required
        require!(
            amount > MIN_AMOUNT_TO_RAISE.pow(self.mint_to_raise.decimals as u32),
            FundraiserError::InvalidAmount
        );

        // Initialize the fundraiser account
        self.fundraiser.set_inner(Fundraiser {
            maker: self.maker.key(),
            mint_to_raise: self.mint_to_raise.key(),
            amount_to_raise: amount,
            current_amount: 0,
            time_started: Clock::get()?.unix_timestamp,
            duration,
            bump: bumps.fundraiser
        });
        
        Ok(())
    }
}
```

In here, we basically just set the data of our Fundraiser account if the amount to raise is bigger than 3 (minimum amount)

---

### Users will be able to contribute to a fundraising

A contribution account consists of:

```rust
#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64,
}
```rust

In this account we will only store the total amount contributed by a specific contributor

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

In this context, we are passing all the accounts needed to contribute to a fundraising campaign:

- contributor: The address of the person that is contributing

- mint_to_raise: the mint that the maker is expecting to receive as contributions

- fundraiser: An initialized Fundraiser account where appropriate checks will be performed, such as the appropriate mint, the seeds and the bump of the Fundraiser PDA

- contributor account: We initialize (if needed) a contributor account that will store the total amount that a specific contributor has contributed with so far

- contributor_ata: The ata where we will be transfering tokens from. We make sure that the authority and mint of the ATA are correct (mint_to_raise and contributor address), and we mark it as mutable since we will be deducting tokens from that account

- vault: The ata where we will be depositing tokens to. We make sure that the authority and mint of the ATA are correct (mint_to_raise and Fundraiser account), and we mark it as mutable since we will be depositing tokens in that account

- token_program: We will performing CPIs (Cross Program Invocations) to the token program to transfer tokens

### We then implement some functionality for our Contribute context:

```rust
impl<'info> Contribute<'info> {
    pub fn contribute(&mut self, amount: u64) -> Result<()> {

        // Check if the amount to contribute meets the minimum amount required
        require!(
            amount > 1_u8.pow(self.mint_to_raise.decimals as u32) as u64, 
            FundraiserError::ContributionTooSmall
        );

        // Check if the amount to contribute is less than the maximum allowed contribution
        require!(
            amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER, 
            FundraiserError::ContributionTooBig
        );

        // Check if the maximum contributions per contributor have been reached
        require!(
            (self.contributor_account.amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER)
                && (self.contributor_account.amount + amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER),
            FundraiserError::MaximumContributionsReached
        );

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            self.fundraiser.duration <= ((current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS) as u8,
            crate::FundraiserError::FundraisingEnded
        );

        // Transfer the funds to the vault
        // CPI to the token program to transfer the funds
        let cpi_program = self.token_program.to_account_info();

        // Transfer the funds from the contributor to the vault
        let cpi_accounts = Transfer {
            from: self.contributor_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.contributor.to_account_info(),
        };

        // Crete a CPI context
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        // Transfer the funds from the contributor to the vault
        transfer(cpi_ctx, amount)?;

        // Update the fundraiser and contributor accounts with the new amounts
        self.fundraiser.current_amount += amount;

        self.contributor_account.amount += amount;

        Ok(())
    }
}
```
In here, we make some checks:
- We check that the user is depositing at least one token

- We Check that the user is not contributiong with more than 10% of the target amount

- We check that the total contributions of the user do not exceed a total of 10% of the target amount

- We check that the fundraising duration has not elapsed

After, we create a CPI to the token program, to transfer a certain amount of SPL tokens from the Contributor ATA to the vault.
We pass the authority of the account where the tokens are being deducted from (In this case is the contributor, as he is the authority of the contributor ata).

Lastly, we update our state acounts with the right amounts

---

### User will be able to claim the tokens once the fundraiding target has been reached

```rust
#[derive(Accounts)]
pub struct CheckContributions<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"fundraiser".as_ref(), maker.key().as_ref()],
        bump = fundraiser.bump,
        close = maker,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = mint_to_raise,
        associated_token::authority = maker,
    )]
    pub maker_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}
```

In this context, we are passing all the accounts needed for a user to claim the raised tokens:

- maker: The address of the person raising the the funds. We mark it as mutable since the maker will be paying for initialization fees and will receive lamports from rent back

- mint_to_raise: the mint that the maker is expecting to receive as contributions

- fundraiser: An initialized Fundraiser account where appropriate checks will be performed, such as the appropriate mint, the seeds and the bump of the Fundraiser PDA

- vault: The ata where we will be transfering tokens from. We make sure that the authority and mint of the ATA are correct (mint_to_raise and fundraiser account), and we mark it as mutable since we will be deducting tokens from that account

- maker_ata: The ata where we will be depositing tokens to. We make sure that the authority and mint of the ATA are correct (mint_to_raise and maker account), and we mark it as mutable since we will be depositing tokens in that account.
In case we need to initialize this ATA, the maker will be paying for the initialization fees

- system_program and associated_token_program: Since we are initializing new ATAs

- token_program: We will performing CPIs (Cross Program Invocations) to the token program to transfer tokens

### We then implement some functionality for our Contribute context:

```rust
impl<'info> CheckContributions<'info> {
    pub fn check_contributions(&self) -> Result<()> {
        
        // Check if the target amount has been met
        require!(
            self.vault.amount >= self.fundraiser.amount_to_raise,
            FundraiserError::TargetNotMet
        );

        // Transfer the funds to the maker
        // CPI to the token program to transfer the funds
        let cpi_program = self.token_program.to_account_info();

        // Transfer the funds from the vault to the maker
        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.maker_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        // Signer seeds to sign the CPI on behalf of the fundraiser account
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        // CPI context with signer since the fundraiser account is a PDA
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);

        // Transfer the funds from the vault to the maker
        transfer(cpi_ctx, self.vault.amount)?;

        Ok(())
    }
}
```

In this implementation, we check if the amount of tokens in the vault is equal or bigger then the fundraising campaign target.
If it is, then we perform a CPI to the token program to transfer the funds from the vault to the maker ATA. Since the vault is an ATA, we need to create our CPI contexr with a signer and use the seeds and bump from the PDA (We are signing with our program on behalf of that PDA).

Finally, we close our Fundraiser account and send the lamports from the rent back to the maker (done with the "close" constraint int the Fundraiser account).


---

### Users will be able to refund their contributions, if the duration of the fundraising has elapsed and the target has not reached

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        close = contributor,
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
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

In this context, we are passing all the accounts needed for a contributor to refund their tokens:

- contributor: The address of the person that is contributing

- maker: The address of the person raising the the funds.

- mint_to_raise: the mint that the maker is expecting to receive as contributions

- fundraiser: An initialized Fundraiser account where appropriate checks will be performed, such as the appropriate mint, the seeds and the bump of the Fundraiser PDA

- contributor account: An initialized Contributor account that will store the total amount that a specific contributor has contributed with so far

- contributor_ata: The ata where we will be transfering tokens to. We make sure that the authority and mint of the ATA are correct (mint_to_raise and contributor address), and we mark it as mutable since we will be depositing tokens to that account

- vault: The ata where we will be withdrawing tokens from. We make sure that the authority and mint of the ATA are correct (mint_to_raise and Fundraiser account), and we mark it as mutable since we will be withdrawing tokens from that account

- token_program: We will performing CPIs (Cross Program Invocations) to the token program to transfer tokens

### We then implement some functionality for our Refund context:

```rust
impl<'info> Refund<'info> {
    pub fn refund(&mut self) -> Result<()> {

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
 
        require!(
            self.fundraiser.duration <= ((current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS) as u8,
            crate::FundraiserError::FundraiserNotEnded
        );

        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            crate::FundraiserError::TargetMet
        );

        // Transfer the funds back to the contributor
        // CPI to the token program to transfer the funds
        let cpi_program = self.token_program.to_account_info();

        // Transfer the funds from the vault to the contributor
        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.contributor_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        // Signer seeds to sign the CPI on behalf of the fundraiser account
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        // CPI context with signer since the fundraiser account is a PDA
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);

        // Transfer the funds from the vault to the contributor
        transfer(cpi_ctx, self.contributor_account.amount)?;

        // Update the fundraiser state by reducing the amount contributed
        self.fundraiser.current_amount -= self.contributor_account.amount;

        Ok(())
    }
}
```

In here, we will check if the fundrasing has already met the target and if ir passed the duration time.
After doing the proper checks, we transfer the donated funds from the vault back to the contributor
