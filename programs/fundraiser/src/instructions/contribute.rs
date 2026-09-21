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
        Fundraiser,
        MilestoneReached,
    }, FundraiserError, 
    ANCHOR_DISCRIMINATOR, 
    MAX_CONTRIBUTION_PERCENTAGE, 
    MILESTONE_DENOMINATOR,
    PERCENTAGE_SCALER, SECONDS_TO_DAYS
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

        // 10% of the target, computed with checked math. `amount_to_raise` is
        // capped by what fits in a u64, so `* 10` can overflow in theory
        // (e.g. a target near u64::MAX) — return a named error instead of
        // panicking on overflow-checks.
        let max_per_contributor = self
            .fundraiser
            .amount_to_raise
            .checked_mul(MAX_CONTRIBUTION_PERCENTAGE)
            .ok_or(FundraiserError::Overflow)?
            / PERCENTAGE_SCALER;

        // Check if the amount to contribute is less than the maximum allowed contribution
        require!(
            amount <= max_per_contributor,
            FundraiserError::ContributionTooBig
        );

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                < self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserEnded
        );

        // Check if the maximum contributions per contributor have been reached.
        // `checked_add` so a contributor total near u64::MAX fails cleanly.
        let new_contributor_total = self
            .contributor_account
            .amount
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;
        require!(
            (self.contributor_account.amount <= max_per_contributor)
                && (new_contributor_total <= max_per_contributor),
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
        // Checked so the running total can never wrap.
        self.fundraiser.current_amount = self
            .fundraiser
            .current_amount
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;

        self.contributor_account.amount = new_contributor_total;

        // ── Quarter milestones (25% / 50% / 75%) ──────────────────────
        // Inline: only `contribute` moves the total upward, so this is the one
        // place a milestone can start being true.
        //
        // `current * 4 / target` (multiply first) keeps precision without
        // floats. `amount_to_raise` is > 0 by `initialize`'s minimum, so the
        // division cannot trap. Each bit fires once, ever; refunds never clear
        // a bit (one-way by design — see README).
        let quarters = self
            .fundraiser
            .current_amount
            .checked_mul(MILESTONE_DENOMINATOR)
            .ok_or(FundraiserError::Overflow)?
            / self.fundraiser.amount_to_raise;

        for i in 0..quarters.min(3) {
            let flag: u8 = 1u8 << i;
            if self.fundraiser.milestones_fired & flag == 0 {
                // Set the flag before emitting: if a future version adds a
                // fallible CPI here, a failure unwinds the flag with it.
                self.fundraiser.milestones_fired |= flag;
                emit!(MilestoneReached {
                    fundraiser: self.fundraiser.key(),
                    quarter: (i + 1) as u8,
                    amount: self.fundraiser.current_amount,
                });
            }
        }

        Ok(())
    }
}