use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{
        mint_to, transfer,
        Mint, MintTo, Token, TokenAccount, Transfer,
    },
};

use crate::{
    state::{Contributor, Fundraiser},
    FundraiserError,
    ANCHOR_DISCRIMINATOR,
    MAX_CONTRIBUTION_PERCENTAGE,
    PERCENTAGE_SCALER,
    SECONDS_TO_DAYS,
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
        bump = fundraiser.bump
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        init_if_needed,
        payer = contributor,
        seeds = [b"contributor".as_ref(), fundraiser.key().as_ref(), contributor.key().as_ref()],
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
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = contributor,
        seeds = [b"receipt", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = fundraiser,
    )]
    pub receipt_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint = receipt_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_receipt_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> Contribute<'info> {
    pub fn contribute(&mut self, amount: u64) -> Result<()> {

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

        self.fundraiser.current_amount += amount;
        self.contributor_account.amount += amount;

        if !self.contributor_account.receipt_minted {
            self.contributor_account.receipt_minted = true;

            let signer_seeds: [&[&[u8]]; 1] = [&[
                b"fundraiser".as_ref(),
                self.fundraiser.maker.as_ref(),
                &[self.fundraiser.bump],
            ]];

            mint_to(
                CpiContext::new_with_signer(
                    self.token_program.key(),
                    MintTo {
                        mint: self.receipt_mint.to_account_info(),
                        to: self.contributor_receipt_ata.to_account_info(),
                        authority: self.fundraiser.to_account_info(),
                    },
                    &signer_seeds,
                ),
                1,
            )?;
        }

        Ok(())
    }
}