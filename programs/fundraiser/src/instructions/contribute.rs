use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer,
    Mint,
    Token,
    TokenAccount,
    Transfer,
};

use crate::{
    state::{
        Contributor,
        Fundraiser,
    },
    FundraiserError,
    ANCHOR_DISCRIMINATOR,
    MAX_CONTRIBUTION_PERCENTAGE,
    PERCENTAGE_SCALER,
    SECONDS_TO_DAYS,
};

/// Accounts required to contribute tokens to a fundraiser.
#[derive(Accounts)]
pub struct Contribute<'info> {
    /// The wallet contributing tokens.
    ///
    /// This wallet signs the transaction, pays for its Contributor PDA
    /// when necessary, and authorizes the token transfer.
    #[account(mut)]
    pub contributor: Signer<'info>,

    /// The SPL token accepted by this fundraiser.
    pub mint_to_raise: Account<'info, Mint>,

    /// The fundraiser receiving the contribution.
    ///
    /// The PDA seeds and stored bump prove that this is the correct
    /// fundraiser account belonging to its maker.
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [
            b"fundraiser",
            fundraiser.maker.as_ref(),
        ],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,

    /// Tracks how much this wallet contributed and whether it already
    /// received its one-time receipt NFT.
    ///
    /// `init_if_needed` creates this PDA on the first contribution.
    /// New account data starts as zeroes, so:
    /// - amount starts at 0
    /// - receipt_minted starts as false
    #[account(
        init_if_needed,
        payer = contributor,
        seeds = [
            b"contributor",
            fundraiser.key().as_ref(),
            contributor.key().as_ref(),
        ],
        bump,
        space = ANCHOR_DISCRIMINATOR + Contributor::INIT_SPACE,
    )]
    pub contributor_account: Account<'info, Contributor>,

    /// The contributor's token account that sends the tokens.
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = contributor,
    )]
    pub contributor_ata: Account<'info, TokenAccount>,

    /// The fundraiser's token vault.
    ///
    /// Its authority is the fundraiser PDA, so an ordinary wallet
    /// cannot withdraw the deposited tokens directly.
    #[account(
        mut,
        associated_token::mint = fundraiser.mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The official SPL Token program performs the token transfer.
    pub token_program: Program<'info, Token>,

    /// The System Program creates the Contributor PDA when needed.
    pub system_program: Program<'info, System>,
}

impl<'info> Contribute<'info> {
    /// Validates and records one contribution.
    pub fn contribute(&mut self, amount: u64) -> Result<()> {
        // Convert one display token into its raw smallest-unit amount.
        //
        // Example:
        // A mint with 6 decimals uses 1,000,000 raw units per token.
        // checked_pow prevents an unusually large decimals value from
        // overflowing a u64 calculation.
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::ArithmeticOverflow)?;

        require!(
            amount >= one_token,
            FundraiserError::ContributionTooSmall
        );

        // Calculate the maximum amount one wallet may contribute.
        //
        // We use checked multiplication and division so attacker-controlled
        // or unexpectedly large numbers cannot wrap around.
        let maximum_contribution = self
            .fundraiser
            .amount_to_raise
            .checked_mul(MAX_CONTRIBUTION_PERCENTAGE)
            .and_then(|value| value.checked_div(PERCENTAGE_SCALER))
            .ok_or(FundraiserError::ArithmeticOverflow)?;

        require!(
            amount <= maximum_contribution,
            FundraiserError::ContributionTooBig
        );

        // Determine how many complete days have elapsed.
        //
        // checked_sub prevents underflow if a malformed or unexpected
        // timestamp is earlier than the fundraiser's starting time.
        let current_time = Clock::get()?.unix_timestamp;

        let elapsed_seconds = current_time
            .checked_sub(self.fundraiser.time_started)
            .ok_or(FundraiserError::ArithmeticOverflow)?;

        let elapsed_days = elapsed_seconds
            .checked_div(SECONDS_TO_DAYS)
            .ok_or(FundraiserError::ArithmeticOverflow)?;

        require!(
            elapsed_days < self.fundraiser.duration as i64,
            FundraiserError::FundraiserEnded
        );

        // Calculate the contributor's new total before transferring tokens.
        //
        // If this addition cannot fit inside a u64, the instruction stops
        // before any tokens move.
        let updated_contributor_amount = self
            .contributor_account
            .amount
            .checked_add(amount)
            .ok_or(FundraiserError::ArithmeticOverflow)?;

        require!(
            updated_contributor_amount <= maximum_contribution,
            FundraiserError::MaximumContributionsReached
        );

        // Calculate the fundraiser's new total before the CPI.
        let updated_fundraiser_amount = self
            .fundraiser
            .current_amount
            .checked_add(amount)
            .ok_or(FundraiserError::ArithmeticOverflow)?;

        // Ask the SPL Token program to move the contribution from the
        // contributor's token account into the fundraiser vault.
        let cpi_accounts = Transfer {
            from: self.contributor_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.contributor.to_account_info(),
        };

        let cpi_context = CpiContext::new(
            self.token_program.key(),
            cpi_accounts,
        );

        transfer(cpi_context, amount)?;

        // Save the already-checked totals only after the transfer succeeds.
        //
        // receipt_minted is deliberately left unchanged. It begins as false
        // and will become true only when mint_receipt succeeds.
        self.fundraiser.current_amount = updated_fundraiser_amount;
        self.contributor_account.amount = updated_contributor_amount;

        Ok(())
    }
}