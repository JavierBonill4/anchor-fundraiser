use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};

use crate::{
    newly_reached_milestones, percentage_of,
    state::{Contributor, Fundraiser},
    FundraiserError, MilestoneReached, ANCHOR_DISCRIMINATOR, MAX_CONTRIBUTION_PERCENTAGE,
    MILESTONES, SECONDS_TO_DAYS,
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
            .ok_or(FundraiserError::MathOverflow)?;

        require!(amount >= one_token, FundraiserError::ContributionTooSmall);

        let maximum_contribution =
            percentage_of(self.fundraiser.amount_to_raise, MAX_CONTRIBUTION_PERCENTAGE)
                .ok_or(FundraiserError::MathOverflow)?;

        // Check if the amount to contribute is less than the maximum allowed contribution.
        require!(
            amount <= maximum_contribution,
            FundraiserError::ContributionTooBig
        );

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
        let elapsed = current_time
            .checked_sub(self.fundraiser.time_started)
            .ok_or(FundraiserError::MathOverflow)?;
        require!(
            elapsed / SECONDS_TO_DAYS < self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserEnded
        );

        let new_contributor_amount = self
            .contributor_account
            .amount
            .checked_add(amount)
            .ok_or(FundraiserError::MathOverflow)?;

        // Check if the maximum contributions per contributor have been reached.
        require!(
            self.contributor_account.amount <= maximum_contribution
                && new_contributor_amount <= maximum_contribution,
            FundraiserError::MaximumContributionsReached
        );

        let new_total = self
            .fundraiser
            .current_amount
            .checked_add(amount)
            .ok_or(FundraiserError::MathOverflow)?;
        let newly_reached = newly_reached_milestones(
            self.fundraiser.amount_to_raise,
            new_total,
            self.fundraiser.milestones_reached,
        )
        .ok_or(FundraiserError::MathOverflow)?;

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

        // Persist contribution totals and every newly crossed milestone.
        self.fundraiser.current_amount = new_total;
        self.contributor_account.amount = new_contributor_amount;
        self.fundraiser.milestones_reached |= newly_reached;

        for (percentage, bit) in MILESTONES {
            if newly_reached & bit != 0 {
                emit!(MilestoneReached {
                    fundraiser: self.fundraiser.key(),
                    percentage,
                    total_amount: new_total,
                });
            }
        }

        Ok(())
    }
}
