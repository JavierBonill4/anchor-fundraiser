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
    CAP_TIER_ONE_PERCENTAGE, CAP_TIER_TWO_PERCENTAGE, CAP_TIER_THREE_PERCENTAGE,
    DEEP_THRESHOLD_PERCENTAGE, HALFWAY_THRESHOLD_PERCENTAGE,
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
    /// The largest a single contributor may hold or add in one call, as a
    /// function of how full the vault already is.
    ///
    /// Before the vault is half full the original 10% cap applies. Once a
    /// campaign has proven itself, a bigger backer is welcome: the cap grows
    /// to 20% past the halfway mark and 30% past three quarters.
    ///
    /// The tier is derived from `current_amount` *before* this contribution is
    /// applied, so a contribution that crosses a threshold still has to respect
    /// the tier it leaves behind - it earns the higher tier for the campaign's
    /// next contribution, not for itself.
    fn contribution_cap(&self) -> Result<u64> {
        let raised_percent = self
            .fundraiser
            .current_amount
            .checked_mul(PERCENTAGE_SCALER)
            .and_then(|v| v.checked_div(self.fundraiser.amount_to_raise))
            .ok_or(FundraiserError::ContributionCapOverflow)?;

        let cap_percent = if raised_percent < HALFWAY_THRESHOLD_PERCENTAGE {
            CAP_TIER_ONE_PERCENTAGE
        } else if raised_percent < DEEP_THRESHOLD_PERCENTAGE {
            CAP_TIER_TWO_PERCENTAGE
        } else {
            CAP_TIER_THREE_PERCENTAGE
        };

        let cap = self
            .fundraiser
            .amount_to_raise
            .checked_mul(cap_percent)
            .and_then(|v| v.checked_div(PERCENTAGE_SCALER))
            .ok_or(FundraiserError::ContributionCapOverflow)?;

        Ok(cap)
    }

    pub fn contribute(&mut self, amount: u64) -> Result<()> {

        // Check that the contribution is at least one whole token.
        //
        // The previous form was `1_u8.pow(decimals)`, and 1 raised to any power is 1
        // — so the check only ever rejected a contribution of a single raw unit.
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::ContributionTooSmall)?;

        require!(amount >= one_token, FundraiserError::ContributionTooSmall);

        // The per-contributor cap scales with how far the campaign has got.
        let cap = self.contribution_cap()?;

        // Check if the amount to contribute is less than the maximum allowed in a single call.
        require!(amount <= cap, FundraiserError::ContributionTooBig);

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                < self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserEnded
        );

        // Check that the cumulative total for this contributor stays within the cap
        let new_total = self
            .contributor_account
            .amount
            .checked_add(amount)
            .ok_or(FundraiserError::ContributionCapOverflow)?;
        require!(
            self.contributor_account.amount <= cap && new_total <= cap,
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

        Ok(())
    }
}