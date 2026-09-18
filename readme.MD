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

---

# Campaign lifecycle

## What it does

A maker used to get **one campaign per mint, ever**. Not one at a time — one, full
stop. This feature gives a campaign an id, and makes both of its endings clean up
after themselves, so a maker can run a second campaign, a third, and so on, and
gets the rent back each time.

## Why it was needed

The fundraiser PDA was derived from `[b"fundraiser", maker]`, and the vault is the
associated token account of that PDA. Both endings left something behind:

| Ending | What survived | What the next `initialize` hit |
|---|---|---|
| Target met | the vault ATA — `check_contributions` emptied it and closed only the Fundraiser | the ATA program: `Provided owner is not allowed` |
| Target missed | the Fundraiser *and* the vault — `refund` closes only the Contributor | the System program: `Allocate: account … already in use` |

Both are in `tests/lifecycle-bankrun.ts` as executed tests, not as a description.

## How it works

- **`id: u64` on `Fundraiser`**, appended after `bump`, and added to the seeds:
  `[b"fundraiser", maker, id.to_le_bytes()]`. Every instruction that signs for the
  PDA carries it in its signer seeds.
- **`check_contributions` closes the vault** it has just emptied, by CPI to the
  token program's `CloseAccount` with the fundraiser PDA as authority, rent to the
  maker. The Fundraiser is still closed by `close = maker`.
- **`close_campaign`** is new: a permissionless crank that winds up a campaign
  which missed its target. It is a crank and not a maker instruction because the
  maker has no incentive to pay a fee to tidy up a campaign that failed, and the
  contributors have already taken their money back. Rent goes to the maker who
  paid it, whoever calls it.
- **`time_started` is a contributor seed.** `[b"contributor", fundraiser,
  contributor, time_started]`. This is the non-obvious part, and it is explained
  under *how you would attack it* below.

Two guards on `close_campaign`, both reachable and both tested:

```rust
require!(window_has_closed,          FundraiserError::FundraiserNotEnded);
require!(self.vault.amount == 0,     FundraiserError::VaultNotEmpty);
```

## What it costs

Measured under `solana-bankrun` (`lamports_per_byte_year` 3480, exemption
threshold 2 — the same parameters as a live cluster):

| Instruction | Compute units |
|---|---|
| `initialize` | 36,195 |
| `contribute` | 28,319 |
| `refund` | 25,087 |
| **`close_campaign`** | **13,013** |

`check_contributions` grew by one `CloseAccount` CPI. `Fundraiser` grew by 8 bytes
for the id — 98 to 106 — which is 55,680 lamports of extra rent per campaign, and
that rent now comes back.

What `close_campaign` returns to the maker: **3,667,920 lamports (0.00366792 SOL)**
— 1,628,640 for the 106-byte Fundraiser plus 2,039,280 for the 165-byte vault ATA.
Before this change, both were stranded permanently on the failure path.

No new accounts. No new rent. The feature is net negative rent by construction.

## How you would attack it

**Close a campaign while contributors' money is still in the vault.** This is the
real one. `refund` derives its signer seeds from the Fundraiser account, so if
`close_campaign` closed the Fundraiser with a non-empty vault, those tokens would
be unreachable forever — there would be no instruction left able to sign for the
vault's authority. `require!(self.vault.amount == 0)` is the whole defence, and
`refuses to wind up a campaign whose contributors have not refunded` is the test
that holds it in place. Deleting that one line turns exactly that test red and
leaves the other six green.

**Reuse an id to poison a returning contributor.** Nothing closes a `Contributor`
on the *success* path — `check_contributions` is signed by the maker, and a
program cannot enumerate accounts, so it has no way to find them. Those accounts
outlive their campaign. If contributor seeds were only
`[b"contributor", fundraiser, person]`, a maker who reused an id would land on the
same fundraiser address, and therefore the same contributor addresses, and
`init_if_needed` in `contribute` would hand a returning backer their *old*
balance: they would be banned by the 10% cumulative cap, and if the second
campaign failed they would refund both campaigns' money out of the second
campaign's vault. Adding `time_started` to those seeds separates two campaigns
that share an id. The residual hole is a maker who closes and reopens the same id
within the same second; a monotonic per-maker counter would close it properly, at
the cost of another account.

**The direct-funding bypass, which this feature does not fix and does not
introduce.** `check_contributions` and `refund` both guard on `vault.amount`,
never on `current_amount`. The vault is an ordinary ATA, so anyone can transfer
into it and move the number those guards read, while `current_amount` — which
nothing on-chain reads — stays where it was. A campaign can therefore pay out
having recorded zero contributions; `still pays out a vault that never saw a
contribution` asserts exactly that. It is out of scope here, but it is worth
knowing that this program's notion of "how much has been raised" has two
disagreeing answers.

**Griefing the crank.** `close_campaign` is permissionless by design. A caller
gains nothing and pays the fee; the rent goes to the maker. There is nothing to
race for.

## What is left undone

Contributor accounts from a *successful* campaign are still stranded. Reclaiming
them needs a fourth instruction — a per-contributor crank, since nothing on-chain
can enumerate them — and this is meant to be one feature. With `time_started` in
the seeds they are now inert rather than dangerous, which is the difference
between a leak and a bug.

## Testing

`tests/lifecycle-bankrun.ts`, five cases: the two happy paths, the boundary at the
deadline (day 6 refused, day 7 accepted), the abuse case above, and the id-reuse
case. Bankrun rather than a validator because three of them need the clock moved.
(The direct-funding case moved to `tests/bookbuild-bankrun.ts` with the next
feature, where it is inverted.)

Each piece of the feature was reverted in turn and the suite re-run:

| Reverted | Result |
|---|---|
| the `CloseAccount` CPI in `check_contributions` | 2 failing, 5 passing |
| `require!(vault.amount == 0)` | **1 failing**, 6 passing — the abuse case |
| `time_started` from the contributor seeds (program and client) | **1 failing**, 6 passing — the id-reuse case |

---

# Oversubscription: the raise clears like a book build

Built on top of the campaign lifecycle above, and it needs it — the tail this
feature creates is exactly what `close_campaign` winds up.

## What it does

A contribution is a **bid**, not a purchase. There is no per-contributor cap:
bid what you like. When the window shuts, if the book is at or over the target,
every bidder is filled in proportion and takes the rest back.

```
filled_i = ceil(amount_to_raise * bid_i / settled_total)
excess_i = bid_i - filled_i
```

The maker is paid **exactly the target**, never the vault. Undersubscribed, and
everything refunds as before.

## Why

The program used to refuse money three ways: under one token, over 10% of target
in a single contribution, over 10% cumulative. The two caps existed to stop one
whale owning a raise, and they paid for it by rejecting the most valuable thing a
fundraiser ever receives — demand.

Pro-rata settlement gets the same protection for nothing. A bid of any size is
diluted by everyone else's, and splitting a bid across a hundred wallets changes
the outcome not at all, so there is no sybil to defend against either. It also
removes the race: under a first-come cap, a popular campaign is a scramble to be
one of the first ten contributors. This is the reasoning behind
[Meteora's Alpha Vault](https://docs.meteora.ag/anti-sniper-suite/alpha-vault/what-is-alpha-vault)
pro-rata mode, and it applies unchanged here.

And the ratio is now a public number. Before, a campaign that scraped to its
target and one with five times that chasing it were indistinguishable on chain.
`settled_total / amount_to_raise` is revealed demand — which, with campaign ids
from the previous feature, is exactly what tells a maker how to size the next
one. The crowd sets the ceiling instead of the founder guessing it.

## How it works

- `contribute` drops both 10% caps. The one-whole-token minimum stays; it is
  anti-dust, not anti-whale.
- `check_contributions` now requires the **window to have shut** before it will
  settle. Without that a maker could settle the moment bids crossed the target,
  which puts the race straight back — whoever triggers settlement freezes out
  every later bid and fixes the fill ratio in their own favour.
- Settlement pays the maker `amount_to_raise`, snapshots `settled_total =
  current_amount`, sets `settled = true`, and **closes nothing**. The vault still
  owes the oversubscribed their excess; the fundraiser holds the numbers needed
  to work out how much.
- `claim_excess` is new. It pays out `excess_i`, decrements `current_amount` by
  the whole bid, and closes the Contributor account.
- `close_campaign` now serves both endings. Its guard moved from
  `vault.amount == 0` to `current_amount == 0` — the book, not the vault — and it
  sweeps whatever dust is left before closing.
- `refund` is gated on `!settled` rather than on the vault balance.

## What it costs

| Instruction | Compute units |
|---|---|
| `initialize` | 34,856 |
| `contribute` (a bid) | 25,429 |
| `check_contributions` | 43,565 |
| **`claim_excess`** | **22,174** |
| `close_campaign` | 17,416 |

Two fields on `Fundraiser` (`settled: bool`, `settled_total: u64`), 9 bytes,
appended. No new accounts: `claim_excess` closes the same Contributor account
`refund` would have, so an oversubscribed bidder reclaims the same rent a
refunded one does.

## How you would attack it

**Stuff the vault to dilute everyone and take their excess.** This is the one
that matters, and it is why this feature was chosen. The vault is an ordinary
associated token account: anyone can transfer into it. The old settlement guard
read `vault.amount`, which as a pass/fail check was merely wrong — a campaign
with no contributions at all could pay out. As the **denominator of everyone's
fill** it would be theft: push the denominator up, every honest bidder's `filled`
falls, their `excess` rises past what the vault can cover, and the last claimers
are left with nothing. The fix is that both numbers now come from program state.
`current_amount` — written twice and read nowhere since the program was written —
is now what decides whether a raise clears, and `settled_total` freezes it so
claimers draining the book cannot move the ratio under each other.
Two tests hold this: *does not count tokens transferred straight into the vault*
and *cannot be diluted by a stranger stuffing the vault after the book shuts*.

**Round the fills the wrong way and the last claimer is insolvent.** With
`filled` rounded down, the fills sum to *less* than the target while the claims
sum to *more* than the vault holds. I simulated 20,000 random books before
writing any Rust: floor rounding runs short by up to 9 units, ceil never runs
short at all. Rounding up leaves dust rather than a hole, and the dust goes to
the maker when the campaign is wound up. Reverting that one `checked_add` turns
both solvency tests red.

**Refund and claim are two doors to the same tokens.** A settled campaign whose
vault has been partly drained by claims looks, by balance alone, like a campaign
under its target. The old `vault.amount < amount_to_raise` refund guard would
have waved through a refund on money the maker had already been paid. Gating on
`settled` closes it. This is the guide's own warning about contribute and refund
being legal at the same moment, one instruction over.

**Bid, then claim twice.** `claim_excess` closes the Contributor account, so the
second attempt has no account to read.

**Never claim, and the campaign can never be wound up.** `close_campaign` waits
for `current_amount == 0`, so one absent bidder strands the maker's rent
indefinitely. Deliberate: the alternative is a deadline after which unclaimed
excess is forfeit, which is a worse failure — it takes real money from someone
who was merely slow. The rent at risk is 0.00366792 SOL; the excess is not.

**A dust griefer stalls the wind-up.** Anyone can transfer a token into the vault
after the last claim. It cannot block the close — the guard counts the book, not
the vault, and the sweep sends whatever is there to the maker. They are simply
donating.

## What is left undone

`current_amount` and `vault.amount` still disagree by design, because the vault
can receive unsolicited transfers. Nothing now *reads* the vault to make a
decision, which is the property that matters, but a reader of the code should
know the two numbers are not the same thing and never will be.

## Testing

`tests/bookbuild-bankrun.ts`, ten cases: pro-rata fills with the arithmetic
asserted to the unit, solvency to the last claimer, both sides of the target
boundary, settlement before the deadline, the two vault-stuffing attacks, double
claim, refund-after-settlement, and a bid at 90% of target that the old cap
refused. `tests/lifecycle-bankrun.ts` is updated for the new flow and still
covers the lifecycle feature underneath.

Each guard was reverted in turn:

| Reverted | Result |
|---|---|
| settlement reads `vault.amount` instead of the book | **1 failing** — the stuffing attack |
| maker paid the whole vault instead of the target | 3 failing — fills, solvency, double-claim |
| fills round down instead of up | **2 failing** — both solvency cases |
| settlement allowed before the deadline | **1 failing** — the deadline test |
| refund gated on the vault balance again | **1 failing** — the double-spend test |

The whole suite, all five files, runs green against a local validator:

```
$ anchor test --validator legacy
  26 passing (24s)
```

Anchor 1.1.2 defaults to `surfpool` for its local validator
(`ValidatorType::Surfpool`, `cli/src/lib.rs`); `--validator legacy` uses
`solana-test-validator`, which ships with the Solana CLI, so no extra install is
needed to reproduce this.
