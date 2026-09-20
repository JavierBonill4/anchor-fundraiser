use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer, Mint, Token, TokenAccount, Transfer,
};

use crate::{
    state::{Contributor, Fundraiser},
    FundraiserError, MilestoneReached, ANCHOR_DISCRIMINATOR,
    MAX_CONTRIBUTION_PERCENTAGE, PERCENTAGE_SCALER, SECONDS_TO_DAYS,
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
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::ContributionTooSmall)?;

        require!(amount >= one_token, FundraiserError::ContributionTooSmall);

        let cap = self
            .fundraiser
            .amount_to_raise
            .checked_mul(MAX_CONTRIBUTION_PERCENTAGE)
            .ok_or(FundraiserError::Overflow)?
            / PERCENTAGE_SCALER;

        require!(amount <= cap, FundraiserError::ContributionTooBig);

        let current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                < self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserEnded
        );

        let next_total = self
            .contributor_account
            .amount
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;
        require!(next_total <= cap, FundraiserError::MaximumContributionsReached);

        let cpi_accounts = Transfer {
            from: self.contributor_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.contributor.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(self.token_program.key(), cpi_accounts);
        transfer(cpi_ctx, amount)?;

        self.fundraiser.current_amount = self
            .fundraiser
            .current_amount
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;

        self.contributor_account.amount = next_total;

        // Where are we now, in quarters? 0..=4
        // Multiply first so 7_500_000 * 4 / 30_000_000 = 1, not 0.
        
        let quarters = self
            .fundraiser
            .current_amount
            .checked_mul(4)
            .ok_or(FundraiserError::Overflow)?
            / self.fundraiser.amount_to_raise;

        for i in 0..quarters.min(3) {
            let flag = 1u8 << i;
            if self.fundraiser.milestones_fired & flag == 0 {
                self.fundraiser.milestones_fired |= flag;
                emit!(MilestoneReached {
                    fundraiser: self.fundraiser.key(),
                    milestone: (i + 1) as u8,
                });
            }
        }
        
        Ok(())
    }
}