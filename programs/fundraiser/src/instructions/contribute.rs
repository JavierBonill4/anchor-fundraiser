use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{
        self as ata_cpi,
        AssociatedToken,
        Create as AtaCreate,
    },
    token::{
        Mint, 
        transfer, 
        Token, 
        TokenAccount, 
        Transfer
    },
    token_2022::{
        self as token_2022_cpi,
        spl_token_2022 as spl_t22,
        InitializeMint2    as T22InitializeMint2,
        MintTo             as T22MintTo,
        SetAuthority       as T22SetAuthority,
        Token2022,
    },
    token_2022_extensions::non_transferable::{
        non_transferable_mint_initialize,
        NonTransferableMintInitialize,
    },
};

use crate::{
    state::{
        Contributor, 
        Fundraiser
    }, FundraiserError, 
    ANCHOR_DISCRIMINATOR, 
    MAX_CONTRIBUTION_PERCENTAGE, 
    PERCENTAGE_SCALER, RECEIPT_SEED, SECONDS_TO_DAYS
};

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

    // ── Receipt NFT accounts (Token-2022) ────────────────────────────
    //
    // Both receipt_mint and contributor_receipt_ata are UncheckedAccounts
    // because they must be created manually in a specific order:
    //
    //   1. Allocate receipt_mint via create_account
    //   2. Initialize the NonTransferable extension (before InitializeMint2)
    //   3. Initialize the mint's base state
    //   4. Create the ATA for the mint (the mint must exist first)
    //   5. Mint 1 token to the ATA
    //   6. Revoke mint authority
    //
    // Anchor's init_if_needed with mint::* or associated_token::* constraints
    // would run before our instruction body and fail because the mint doesn't
    // exist yet on the first contribution. The seeds constraint still validates
    // the PDA derivation on every call.
    /// CHECK: Validated via seeds constraint; allocated and initialised
    /// manually inside `contribute()` on the first contribution.
    #[account(
        mut,
        seeds = [RECEIPT_SEED, fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
    )]
    pub receipt_mint: UncheckedAccount<'info>,

    /// CHECK: Derived as the ATA of receipt_mint for the contributor on
    /// Token-2022. Created idempotently inside `contribute()` after the
    /// mint has been initialised.
    #[account(mut)]
    pub contributor_receipt_ata: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> Contribute<'info> {
    pub fn contribute(&mut self, amount: u64, bumps: &ContributeBumps) -> Result<()> {

        // Check that the contribution is at least one whole token.
        //
        // The previous form was `1_u8.pow(decimals)`, and 1 raised to any power is 1
        // — so the check only ever rejected a contribution of a single raw unit.
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::ContributionTooSmall)?;

        require!(amount >= one_token, FundraiserError::ContributionTooSmall);

        // Check if the amount to contribute is less than the maximum allowed contribution
        require!(
            amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER, 
            FundraiserError::ContributionTooBig
        );

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                < self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserEnded
        );

        // Check if the maximum contributions per contributor have been reached
        require!(
            (self.contributor_account.amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER)
                && (self.contributor_account.amount + amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER),
            FundraiserError::MaximumContributionsReached
        );

        // ── Capture first-contribution flag before any state mutation ──
        let is_first_contribution = !self.contributor_account.has_receipt;

        // Transfer the funds from the contributor to the vault.
        // As of Anchor 1.0 a CpiContext takes the program's *address*, not its
        // AccountInfo.
        let cpi_accounts = Transfer {
            from: self.contributor_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.contributor.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(self.token_program.key(), cpi_accounts);

        // Transfer the funds from the contributor to the vault
        transfer(cpi_ctx, amount)?;

        // Update the fundraiser and contributor accounts with the new amounts
        self.fundraiser.current_amount = self.fundraiser.current_amount
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;

        self.contributor_account.amount = self.contributor_account.amount
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;

        // ── Mint receipt NFT on first contribution ─────────────────────
        if is_first_contribution {
            self.contributor_account.has_receipt = true;

            // Signer seeds for the fundraiser PDA (authority of the mint)
            let signer_seeds: &[&[&[u8]]] = &[&[
                b"fundraiser".as_ref(),
                self.fundraiser.maker.as_ref(),
                &[self.fundraiser.bump],
            ]];

            // ── 0. Allocate the receipt_mint account ───────────────────
            //
            // Compute the space needed for a Mint with the NonTransferable
            // extension, then create the account owned by Token-2022.
            let mint_size = spl_t22::extension::ExtensionType::try_calculate_account_len::<
                spl_t22::state::Mint,
            >(&[spl_t22::extension::ExtensionType::NonTransferable])
                .map_err(|_| FundraiserError::Overflow)?;

            let lamports = Rent::get()?.minimum_balance(mint_size);

            let receipt_seeds: &[&[u8]] = &[
                RECEIPT_SEED,
                self.fundraiser.to_account_info().key.as_ref(),
                self.contributor.to_account_info().key.as_ref(),
                &[bumps.receipt_mint],
            ];

            anchor_lang::system_program::create_account(
                CpiContext::new_with_signer(
                    self.system_program.key(),
                    anchor_lang::system_program::CreateAccount {
                        from: self.contributor.to_account_info(),
                        to:   self.receipt_mint.to_account_info(),
                    },
                    &[receipt_seeds],
                ),
                lamports,
                mint_size as u64,
                &self.token_2022_program.key(),
            )?;

            // ── 1. Initialise the NonTransferable extension ────────────
            //
            // MUST happen before InitializeMint2 — Token-2022 requires
            // extension data to be reserved in the TLV layout first.
            non_transferable_mint_initialize(
                CpiContext::new(
                    self.token_2022_program.key(),
                    NonTransferableMintInitialize {
                        token_program_id: self.token_2022_program.to_account_info(),
                        mint:             self.receipt_mint.to_account_info(),
                    },
                ),
            )?;

            // ── 2. Initialise the mint's base state (0 decimals) ───────
            token_2022_cpi::initialize_mint2(
                CpiContext::new(
                    self.token_2022_program.key(),
                    T22InitializeMint2 {
                        mint: self.receipt_mint.to_account_info(),
                    },
                ),
                0,                            // decimals
                &self.fundraiser.key(),        // mint authority
                None,                          // no freeze authority
            )?;

            // ── 3. Create the ATA for the receipt mint ─────────────────
            //
            // create_idempotent is safe to call on every first contribution
            // (no-ops if the ATA already exists). We create it here because
            // the mint must exist before the ATA can be created.
            ata_cpi::create_idempotent(
                CpiContext::new(
                    self.associated_token_program.key(),
                    AtaCreate {
                        payer:            self.contributor.to_account_info(),
                        associated_token: self.contributor_receipt_ata.to_account_info(),
                        authority:        self.contributor.to_account_info(),
                        mint:             self.receipt_mint.to_account_info(),
                        system_program:   self.system_program.to_account_info(),
                        token_program:    self.token_2022_program.to_account_info(),
                    },
                ),
            )?;

            // ── 4. Mint exactly 1 receipt token ────────────────────────
            token_2022_cpi::mint_to(
                CpiContext::new_with_signer(
                    self.token_2022_program.key(),
                    T22MintTo {
                        mint:      self.receipt_mint.to_account_info(),
                        to:        self.contributor_receipt_ata.to_account_info(),
                        authority: self.fundraiser.to_account_info(),
                    },
                    signer_seeds,
                ),
                1,
            )?;

            // ── 5. Remove mint authority so supply can never exceed 1 ──
            token_2022_cpi::set_authority(
                CpiContext::new_with_signer(
                    self.token_2022_program.key(),
                    T22SetAuthority {
                        current_authority: self.fundraiser.to_account_info(),
                        account_or_mint:   self.receipt_mint.to_account_info(),
                    },
                    signer_seeds,
                ),
                spl_t22::instruction::AuthorityType::MintTokens,
                None,
            )?;
        }

        Ok(())
    }
}