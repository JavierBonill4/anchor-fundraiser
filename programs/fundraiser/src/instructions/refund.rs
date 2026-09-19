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
    SECONDS_TO_DAYS,
};

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,

    pub maker: SystemAccount<'info>,

    pub mint_to_raise: Account<'info, Mint>,

    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [
            b"fundraiser",
            maker.key().as_ref()
        ],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,

    #[account(
        mut,
        seeds = [
            b"contributor",
            fundraiser.key().as_ref(),
            contributor.key().as_ref()
        ],
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

impl<'info> Refund<'info> {
    pub fn refund(&mut self) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;

        // Refunds are only allowed after the fundraiser has ended.
        require!(
            self.fundraiser.duration
                <= ((current_time - self.fundraiser.time_started)
                    / SECONDS_TO_DAYS) as u8,
            FundraiserError::FundraiserNotEnded
        );

        // Refunds are only allowed when the fundraising target
        // has not been reached.
        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            FundraiserError::TargetMet
        );

        /*
         * Calculate the new fundraiser amount safely.
         *
         * checked_sub prevents an integer underflow if the stored
         * contributor amount is ever greater than current_amount.
         */
        let new_current_amount = self
            .fundraiser
            .current_amount
            .checked_sub(self.contributor_account.amount)
            .ok_or(FundraiserError::ArithmeticOverflow)?;

        /*
         * Anchor 1.x used by this repository expects the CPI
         * program ADDRESS here, not AccountInfo.
         */
        let cpi_program = self.token_program.key();

        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.contributor_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        /*
         * The fundraiser PDA owns the vault.
         *
         * fundraiser PDA seeds:
         *
         * ["fundraiser", maker_pubkey]
         */
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser",
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        let cpi_ctx = CpiContext::new_with_signer(
            cpi_program,
            cpi_accounts,
            &signer_seeds,
        );

        transfer(
            cpi_ctx,
            self.contributor_account.amount,
        )?;

        /*
         * Only update accounting after the token transfer succeeds.
         */
        self.fundraiser.current_amount = new_current_amount;

        /*
         * milestones_fired is intentionally NOT changed.
         *
         * Milestones are historical records:
         *
         * if the fundraiser once reached 25%, 50%, or 75%,
         * that achievement remains recorded even if later refunds
         * reduce current_amount.
         */

        Ok(())
    }
}