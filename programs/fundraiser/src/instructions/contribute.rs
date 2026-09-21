use anchor_lang::prelude::*;
use anchor_spl::token::{
    Mint, 
    transfer, 
    Token, 
    TokenAccount, 
    Transfer
};

use crate::{
    ANCHOR_DISCRIMINATOR, MAX_CONTRIBUTION_PERCENTAGE, MAX_TICKETS_PER_CONTRIBUTOR, PERCENTAGE_SCALER, SECONDS_TO_DAYS, error::FundraiserError, state::{
        Contributor, 
        Fundraiser
    }
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

        // Check if the maximum contributions per contributor have been reached
        let max_per_contributor = self.fundraiser.amount_to_raise
            .checked_mul(MAX_CONTRIBUTION_PERCENTAGE)
            .ok_or(FundraiserError::Overflow)?
            / PERCENTAGE_SCALER;

        require!(amount <= max_per_contributor, FundraiserError::ContributionTooBig);

         // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            current_time.checked_sub(self.fundraiser.time_started).ok_or(FundraiserError::Overflow)? / SECONDS_TO_DAYS
                < self.fundraiser.duration as i64,
                FundraiserError::FundraiserEnded
        );

        // Cumulative cap across all of this contributor's contributions.
        let new_total = self.contributor_account.amount
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;
        require!(new_total <= max_per_contributor,FundraiserError::MaximumContributionsReached);

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

        self.contributor_account.amount = new_total;

        let ticket_unit = self.fundraiser.amount_to_raise
            .checked_mul(25)
            .ok_or(FundraiserError::Overflow)?
            .checked_div(10_000)
            .ok_or(FundraiserError::Overflow)?;

        let tickets_to_grant = amount
            .checked_div(ticket_unit)
            .ok_or(FundraiserError::Overflow)?
            .min(MAX_TICKETS_PER_CONTRIBUTOR as u64);

        let already_held = self.contributor_account.ticket_end
            .checked_sub(self.contributor_account.ticket_start)
            .unwrap_or(0);

        let available_ticket = MAX_TICKETS_PER_CONTRIBUTOR.saturating_sub(already_held) as u64;
        let ticket_to_grant = tickets_to_grant.min(available_ticket) as u64;

        if ticket_to_grant > 0 {
            if already_held == 0 {
                self.contributor_account.ticket_start = self.fundraiser.total_tickets;
            }
            self.fundraiser.total_tickets = self.fundraiser.total_tickets
                .checked_add(ticket_to_grant)
                .ok_or(FundraiserError::Overflow)?;
            self.contributor_account.ticket_end = self.contributor_account.ticket_start
                .checked_add(already_held)
                .and_then(|e| e.checked_add(ticket_to_grant))
                .ok_or(FundraiserError::Overflow)?;
        }

        Ok(())
    }
}