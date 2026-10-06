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
    pub fn contribute(&mut self, amount: u64, remaining: &[AccountInfo<'info>]) -> Result<()> {

        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::ContributionTooSmall)?;

        require!(amount >= one_token, FundraiserError::ContributionTooSmall);

        require!(
            amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER,
            FundraiserError::ContributionTooBig
        );

        let current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                < self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserEnded
        );

        require!(
            (self.contributor_account.amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER)
                && (self.contributor_account.amount + amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER),
            FundraiserError::MaximumContributionsReached
        );

        let cpi_accounts = Transfer {
            from: self.contributor_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.contributor.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(self.token_program.key(), cpi_accounts);

        transfer(cpi_ctx, amount)?;

        let matched = amount.min(self.fundraiser.match_remaining);
        if matched > 0 {
            let match_vault = remaining.first().ok_or(crate::FundraiserError::MatchVaultMissing)?;
            let seeds = &[
                b"fundraiser".as_ref(),
                self.fundraiser.maker.as_ref(),
                &[self.fundraiser.bump],
            ];
            let signer = &[&seeds[..]];
            let match_cpi = CpiContext::new_with_signer(
                self.token_program.key(),
                Transfer {
                    from: match_vault.to_account_info(),
                    to: self.vault.to_account_info(),
                    authority: self.fundraiser.to_account_info(),
                },
                signer,
            );
            transfer(match_cpi, matched)?;
            self.fundraiser.match_remaining -= matched;
            self.fundraiser.current_amount = self
                .fundraiser
                .current_amount
                .checked_add(matched)
                .ok_or(crate::FundraiserError::InvalidAmount)?;
        }
        self.fundraiser.current_amount += amount;


        if !self.contributor_account.has_contributed {
            self.contributor_account.has_contributed = true;
            msg!("First contribution from {}", self.contributor.key());
        }

        self.contributor_account.amount += amount;

        Ok(())
    }
}
