use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};

use crate::{
    state::{Contributor, Fundraiser},
    FundraiserError, ANCHOR_DISCRIMINATOR, MAX_CONTRIBUTION_PERCENTAGE, PERCENTAGE_SCALER,
    SECONDS_TO_DAYS,
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
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> Contribute<'info> {
    pub fn contribute(&mut self, amount: u64) -> Result<()> {
        // No tickets after the draw: they could never win, and the money would
        // silently inflate the prize the already-decided winner collects.
        require!(!self.fundraiser.drawn, FundraiserError::AlreadyDrawn);

        // Check that the contribution is at least one whole token.
        //
        // The previous form was `1_u8.pow(decimals)`, and 1 raised to any power is 1
        // — so the check only ever rejected a contribution of a single raw unit.
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::ContributionTooSmall)?;

        require!(amount >= one_token, FundraiserError::ContributionTooSmall);

        // The per-contributor ceiling, computed once.
        let max_contribution = self
            .fundraiser
            .amount_to_raise
            .checked_mul(MAX_CONTRIBUTION_PERCENTAGE)
            .ok_or(FundraiserError::MathOverflow)?
            .checked_div(PERCENTAGE_SCALER)
            .ok_or(FundraiserError::MathOverflow)?;

        // Check if the amount to contribute is less than the maximum allowed contribution
        require!(
            amount <= max_contribution,
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
        let contributor_total = self
            .contributor_account
            .amount
            .checked_add(amount)
            .ok_or(FundraiserError::MathOverflow)?;

        require!(
            contributor_total <= max_contribution,
            FundraiserError::MaximumContributionsReached
        );

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

        // One ticket per raw token, as a contiguous range. `total_tickets` is both
        // the count and the cursor the next range starts at. It is kept separate
        // from `current_amount` because `refund` decrements that one, and tickets
        // are never un-issued.
        let ticket_start = self.fundraiser.total_tickets;
        let ticket_end = ticket_start
            .checked_add(amount)
            .ok_or(FundraiserError::MathOverflow)?;

        if self.contributor_account.amount == 0 {
            self.contributor_account.ticket_start = ticket_start;
        } else {
            // A repeat contribution can only extend the range, and only while it is
            // still the last one handed out. Overwriting would orphan the earlier
            // tickets and the draw could land on a number nobody could claim.
            require!(
                self.contributor_account.ticket_end == ticket_start,
                FundraiserError::NonContiguousTickets
            );
        }
        self.contributor_account.ticket_end = ticket_end;

        self.fundraiser.current_amount = self
            .fundraiser
            .current_amount
            .checked_add(amount)
            .ok_or(FundraiserError::MathOverflow)?;
        self.fundraiser.total_tickets = ticket_end;
        self.contributor_account.amount = contributor_total;

        Ok(())
    }
}
