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
    ANCHOR_DISCRIMINATOR, 
    MAX_CONTRIBUTION_PERCENTAGE, 
    PERCENTAGE_SCALER, SECONDS_TO_DAYS,
    MilestoneReached,
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

        // Update the fundraiser and contributor accounts with the new amounts.
        // checked_add, not +=: overflow-checks = true makes a bare + panic on
        // overflow rather than corrupt state, but a panic is an unhelpful log —
        // a named error is better, and it's what checkpoint's "money math is
        // checked" rule asks for.
        self.fundraiser.current_amount = self
            .fundraiser
            .current_amount
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;

        self.contributor_account.amount = self
            .contributor_account
            .amount
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;

        // Fire milestone events at the quarter marks, once each.
        //
        // This computes WHERE we are now, not what changed — current * 4 /
        // target, multiply before divide so the integer division doesn't
        // floor to zero. A single contribution here is capped at 10% of the
        // target (ContributionTooBig, above), so it can only ever cross one
        // quarter mark at a time, but the loop handles a larger jump anyway
        // in case that cap ever changes.
        //
        // milestones_fired is a one-way bitflag: once set, a bit never
        // clears, even if current_amount later falls. See the README for
        // why that's a deliberate tradeoff, not an oversight.
        let quarters = self
            .fundraiser
            .current_amount
            .checked_mul(4)
            .ok_or(FundraiserError::Overflow)?
            .checked_div(self.fundraiser.amount_to_raise)
            .ok_or(FundraiserError::Overflow)?;

        for i in 0..quarters.min(3) {
            let flag = 1u8 << (i as u32);
            if self.fundraiser.milestones_fired & flag == 0 {
                self.fundraiser.milestones_fired |= flag;
                emit!(MilestoneReached {
                    fundraiser: self.fundraiser.key(),
                    milestone_percent: 25 * (i as u8 + 1),
                    current_amount: self.fundraiser.current_amount,
                    amount_to_raise: self.fundraiser.amount_to_raise,
                });
            }
        }

        Ok(())
    }
}
