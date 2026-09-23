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

---

## Custom feature: Milestones

> A rule that only your TypeScript obeys is not a rule. If the program does not
> enforce it, it does not exist.

### What it does

*Written before any code, and unchanged since.*

**Milestones** records, on-chain and exactly once, the first time a campaign's
contributed total reaches 25%, 50% and 75% of its target. The check runs inside
`contribute`, after the transfer and the total update, so no contribution can
push the total past a mark without the program recording it. Each mark is one
bit in a new `milestones_fired: u8` on `Fundraiser`. The contribution that
crosses a mark sets its bit and emits a `MilestoneReached` event, and a bit is
never cleared. Milestones are history, not a live gauge: refunds lower the total
but don't clear a mark. They also can't make a mark fire again, because refunds
only open after contributions have closed. A new `assert_milestone` instruction
fails with `MilestoneNotReached` unless a given mark has fired. Any transaction
can include it, so other apps can require a milestone and have the chain enforce
it rather than a frontend.

### How it works

**State.** One field, appended after `bump` so no existing offset moves:

```rust
pub milestones_fired: u8, // bit i set once MILESTONE_QUARTERS[i] is reached
```

| Bit | Quarter | Reached when |
| --- | --- | --- |
| `0b001` | 1 | `current_amount * 4 >= amount_to_raise * 1` |
| `0b010` | 2 | `current_amount * 4 >= amount_to_raise * 2` |
| `0b100` | 3 | `current_amount * 4 >= amount_to_raise * 3` |

`initialize` sets it to `0` explicitly, so a campaign always starts with no
milestones.

**Timing: inline, at the end of `contribute`.** The trigger is a number that
only `contribute` raises, so the check runs right after `current_amount` moves.
It runs on every successful contribution, and no client can leave it out. A
separate crank would only fire if somebody remembered to call it.

`fire_milestones` loops over the quarters. For each one whose bit is clear and
whose threshold is reached, it **sets the bit first**, then emits
`MilestoneReached { fundraiser, quarter, amount }`. Two details matter:

- **Cross-multiplied, in `u128`.** `target * 25 / 100` rounds down and would
  fire a quarter a fraction of a unit early (for a 30,000,001 target, at
  7,500,000 instead of 7,500,000.25). Comparing `current * 4` with `target * q`
  never divides. Widening to `u128` means the multiply cannot overflow.
- **A loop, not three `if`s.** The 10% cap means one contribution moves the
  total at most 10 points, so it can never cross two quarters. The loop stays
  correct if the cap changes.

**Why a fired bit is never cleared.** `contribute` requires the window to be
open, and `refund` requires it to be closed. So once the first refund lowers
the total, no contribution can ever raise it again. Clearing bits on refund
would only ever turn bits off; it could never let a quarter fire twice.
Keeping them makes the bitmask an honest record of what happened.

**Which total it watches.** `current_amount`, which only `contribute` and
`refund` change, not `vault.amount`, which anyone can raise with a plain token
transfer. See attack 4.

**New instruction: `assert_milestone(quarter: u8)`.** One read-only account,
`fundraiser`, checked by owner, discriminator and seeds
`[b"fundraiser", fundraiser.maker]`. There is no signer, so anyone may call it.
It reads the **bit**, not `current_amount`, so it agrees with the history
above.

| Error | When |
| --- | --- |
| `InvalidMilestone` | `quarter` is not 1, 2 or 3 |
| `MilestoneNotReached` | the quarter's bit is not set |
| `MathOverflow` | a threshold multiply overflows; unreachable in `u128`, kept because the rule is "no bare math" |

New errors are appended, so the original codes 6000–6007 keep their numbers.

**Tests.** `tests/milestones.ts` runs on bankrun, so it can move the clock
for the refund case and decode events from each transaction's logs:

- **happy path:** each quarter fires once, with its event;
- **boundary:** one raw unit below a quarter does not fire, exactly on it does,
  and a target not divisible by four is not rounded down;
- **abuse:** a quarter never fires twice; quarters 0, 4 and 255 are refused
  with `InvalidMilestone`; a quarter stays fired after refunds empty the vault.

Commenting out the `fire_milestones()` call turns 5 of the 7 red. Replacing the
cross-multiply with division, or removing the "already fired" check, each turn
the test written for them red.

### What it costs

Measured on bankrun with fixed keypairs, so each build sees identical addresses
and PDA bumps, comparing builds with and without the `fire_milestones()` call:

| | Without | With | Added |
| --- | --- | --- | --- |
| `contribute`, no quarter crossed | 39,137 CU | 39,158 CU | **+21 CU** |
| `contribute`, crossing a quarter | 31,637 CU | 31,978 CU | **+341 CU** (bit + event) |
| `initialize` | 45,150 CU | 45,150 CU | 0 |
| `assert_milestone`: pass, not reached, invalid | n/a | 2,548, 4,150, 3,665 CU | new |
| `Fundraiser` account | 98 bytes | 99 bytes | +1 byte |
| `Fundraiser` rent | 1,572,960 lamports | 1,579,920 lamports | **+6,960 lamports**, returned to the maker when `check_contributions` closes the account |

- **Extra accounts:** none on any original instruction. `assert_milestone`
  takes one read-only account and 1 byte of arguments.
- **Log space:** each fired quarter writes one `Program data:` line
  (49 bytes of event, about 68 characters of base64). That counts towards the
  transaction's log limit; see attack 5.
- **Absolute CU varies** by roughly 1,500 CU per extra attempt that
  `contribute`'s `find_program_address` needs for the Contributor bump, which
  depends on the wallet. The deltas above don't.

### How you would attack it

1. **Buy the milestones with your own money, and get it back.** The 10% cap
   is per wallet, not per person, and wallets are free. A maker can push their
   own campaign to 75% through fresh wallets. If the campaign fails, every
   wallet refunds. If it succeeds, `check_contributions` pays the maker their
   own money back. The cost is fees, rent and tying up the capital until the
   deadline. **A milestone proves that money moved through `contribute`, not
   that independent people back the campaign.** Nothing on-chain can tell the
   two apart without identity, which is why no reward is attached to a
   milestone.
2. **Hand `assert_milestone` a different fundraiser.** It proves that *the
   account you passed* is a genuine `Fundraiser` with that bit set. It cannot
   know which campaign you meant. A perk that gates on "quarter 3 reached" but
   doesn't pin the fundraiser's address (or its `maker`) can be satisfied by
   an attacker's own self-funded campaign (attack 1). Pinning the address is
   the consumer's job.
3. **Same address, different campaign.** The Fundraiser PDA is
   `[b"fundraiser", maker]`. After `check_contributions` closes it, the same
   maker can `initialize` again at the same address with a different mint (the
   old vault ATA is never closed, so the same mint's vault `init` fails), and
   the bits reset to `0`. A consumer that remembered "this address reached 75%" is now looking at
   a different campaign. Key on `(address, time_started)`, not the address
   alone. (The original program has a worse version of this problem: it leaves
   every `Contributor` PDA open. That is out of scope here, but that's the next
   feature.)
4. **Move the vault without moving the total.** Anyone can transfer tokens
   straight into the vault ATA. `check_contributions` and `refund` read
   `vault.amount`; milestones read `current_amount`. So a campaign can reach
   its target with no milestone fired, and a direct transfer both dodges the
   10% cap and never shows up in the milestones. Watching `current_amount` is
   deliberate: it's the only total the program controls, and it matches the
   per-contributor records that refunds pay out. The cost is that the two
   totals can disagree, and this README says so rather than hiding it.
5. **Blind the indexers.** Events are log lines, and the runtime truncates a
   transaction's logs past its byte limit. If an attacker crosses a quarter in
   a transaction that logs heavily *before* `contribute`, `MilestoneReached`
   can be cut off, and an indexer reading only logs never sees it. The bit is
   still set, because state can't be truncated. **The bitmask is the source of
   truth, and the event is a notification.** `emit_cpi!` would avoid this, at
   the cost of two more accounts and a self-CPI on every contribution.
6. **Race for the crossing.** The contributor whose transaction crosses a mark
   is visible only as that transaction's signer; the event doesn't name them. No reward is attached, so there's nothing to
   front-run. If a later feature pays "the contributor who crossed 50%", the
   crossing becomes a race that validators and bots win. Pay the crossing
   contributor nothing.
7. **Read "reached" as "currently at".** A campaign can fire quarter 3 and then
   refund down to zero, and the bit still says reached. That's the design, but
   a consumer that wants the *current* level must read `current_amount`
   instead.
8. **Out-of-range arithmetic, and what we didn't touch.** `MathOverflow` is
   unreachable because the math is `u128`. If someone narrowed it back to
   `u64`, large targets would make every crossing contribution fail. The
   original `contribute` already does bare `amount_to_raise * 10`, which panics
   for targets above `u64::MAX / 10` before our code runs. We left the four
   original instructions as they were, so that stays a known issue in the base
   program, not something this feature introduces.

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
