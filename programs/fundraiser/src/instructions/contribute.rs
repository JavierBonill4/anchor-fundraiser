use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{mint_to, transfer, Mint, MintTo, Token, TokenAccount, Transfer},
};

use crate::{
    reward::scale_to_reward,
    state::{Contributor, Fundraiser},
    FundraiserError, ANCHOR_DISCRIMINATOR, MAX_CONTRIBUTION_PERCENTAGE, PERCENTAGE_SCALER,
    REWARD_MINT_SEED, SECONDS_TO_DAYS,
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
    #[account(
        mut,
        seeds = [REWARD_MINT_SEED, fundraiser.key().as_ref()],
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
            amount
                <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE)
                    / PERCENTAGE_SCALER,
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
            (self.contributor_account.amount
                <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE)
                    / PERCENTAGE_SCALER)
                && (self.contributor_account.amount + amount
                    <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE)
                        / PERCENTAGE_SCALER),
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

                // Mint the matching reward. Both decimals come from the mint accounts,
        // not from an assumed offset, so the 1:1 whole token rate holds regardless.
        let reward_amount = scale_to_reward(
            amount,
            self.mint_to_raise.decimals,
            self.reward_mint.decimals,
        )?;

        // The fundraiser PDA is the reward mint's authority, so it signs.
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.fundraiser.maker.as_ref(),
            &[self.fundraiser.bump],
        ]];

        let mint_accounts = MintTo {
            mint: self.reward_mint.to_account_info(),
            to: self.contributor_reward_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };
        let mint_ctx =
            CpiContext::new_with_signer(self.token_program.key(), mint_accounts, &signer_seeds);
        mint_to(mint_ctx, reward_amount)?;

        // Update the fundraiser and contributor accounts with the new amounts
        self.fundraiser.current_amount = self
            .fundraiser
            .current_amount
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        self.contributor_account.amount = self
            .contributor_account
            .amount
            .checked_add(amount)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        Ok(())
    }
}
