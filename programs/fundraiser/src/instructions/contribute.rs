use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{
        mint_to,
        transfer,
        Mint,
        MintTo,
        Token,
        TokenAccount,
        Transfer,
    },
};

use crate::{
    state::{
        Contributor, 
        Fundraiser
    }, FundraiserError, 
    ANCHOR_DISCRIMINATOR, 
    MAX_CONTRIBUTION_PERCENTAGE, 
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
    // The reward mint from `initialize`
    #[account(
        mut,
        seeds = [b"reward", fundraiser.key().as_ref()],
        bump,
    )]
    pub reward_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint = reward_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_reward_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
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
        // -----------------------------------------
        // --- Reward token: mint proportionally ---
        //------------------------------------------
        //
        // `amount` is denominated in mint_to_raise's raw units. The reward mint
        // can have a *different* decimals count (it does here on purpose — see
        // REWARD_DECIMALS), so minting the same raw integer would silently mint
        // the wrong number of reward tokens whenever the two mints don't match.
        // Convert through a common scale instead: multiply by the reward mint's
        // scale before dividing by the raise mint's scale (multiply-before-divide,
        // same rule as the milestone example — divide first and you lose
        // precision for nothing), and do the multiply in u128 so a large
        // contribution times a 10^9 scale can't overflow a u64 mid-calculation.
        let raise_scale = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::Overflow)?;
        let reward_scale = 10u64
            .checked_pow(self.reward_mint.decimals as u32)
            .ok_or(FundraiserError::Overflow)?;

        let reward_amount: u64 = (amount as u128)
            .checked_mul(reward_scale as u128)
            .ok_or(FundraiserError::Overflow)?
            .checked_div(raise_scale as u128)
            .ok_or(FundraiserError::Overflow)?
            .try_into()
            .map_err(|_| FundraiserError::Overflow)?;

        // Mint the reward. The fundraiser PDA is the mint authority (not the
        // reward mint's own PDA — a mint can't sign for itself), so this CPI
        // is signed the same way check_contributions signs its payout: with
        // the fundraiser's own seeds.
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.fundraiser.maker.as_ref(),
            &[self.fundraiser.bump],
        ]];

        let mint_cpi_accounts = MintTo {
            mint: self.reward_mint.to_account_info(),
            to: self.contributor_reward_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let mint_cpi_ctx = CpiContext::new_with_signer(
            self.token_program.key(),
            mint_cpi_accounts,
            &signer_seeds,
        );

        mint_to(mint_cpi_ctx, reward_amount)?;

        // Update the fundraiser and contributor accounts with the new amounts.
        // Checked, per the assignment's own money-math rule — the original two
        // lines here were bare `+=`.
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

        self.contributor_account.reward_amount = self
            .contributor_account
            .reward_amount
            .checked_add(reward_amount)
            .ok_or(FundraiserError::Overflow)?;

        Ok(())
    }
}
