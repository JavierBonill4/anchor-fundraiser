use anchor_lang::prelude::*;
use anchor_spl::token::{
    Mint, 
    transfer, 
    Token, 
    TokenAccount, 
    Transfer
};

use crate::{
    state::{
        Contributor, 
        Fundraiser
    }, FundraiserError,
    MilestoneReached,
    ANCHOR_DISCRIMINATOR,
    MAX_CONTRIBUTION_PERCENTAGE,
    MILESTONE_QUARTERS,
    PERCENTAGE_SCALER, QUARTERS_PER_TARGET, SECONDS_TO_DAYS
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
        self.fundraiser.current_amount += amount;

        self.contributor_account.amount += amount;

        // Runs after the total has moved, so no contribution can cross a
        // milestone without firing it.
        self.fire_milestones()?;

        Ok(())
    }

    fn fire_milestones(&mut self) -> Result<()> {
        // Cross-multiply instead of dividing, so rounding can never fire a
        // milestone early. u128 so a u64 times 4 cannot overflow.
        let raised = (self.fundraiser.current_amount as u128)
            .checked_mul(QUARTERS_PER_TARGET)
            .ok_or(FundraiserError::MathOverflow)?;

        // A loop rather than one `if` per quarter: the 10% cap means one
        // contribution cannot cross two quarters today, but this stays
        // correct if the cap changes.
        for (i, quarter) in MILESTONE_QUARTERS.iter().enumerate() {
            let bit = 1u8 << i;
            if self.fundraiser.milestones_fired & bit != 0 {
                continue;
            }

            let threshold = (self.fundraiser.amount_to_raise as u128)
                .checked_mul(*quarter as u128)
                .ok_or(FundraiserError::MathOverflow)?;
            if raised < threshold {
                // Quarters are ascending, so none after this one is reached.
                break;
            }

            // Set the flag before doing the work.
            self.fundraiser.milestones_fired |= bit;

            emit!(MilestoneReached {
                fundraiser: self.fundraiser.key(),
                quarter: *quarter,
                amount: self.fundraiser.current_amount,
            });
        }

        Ok(())
    }
}