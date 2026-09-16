use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer,
    close_account,
    Mint, 
    Token, 
    TokenAccount, 
    Transfer,
    CloseAccount
};

use crate::{
    state::{
        Contributor, 
        Fundraiser
    }, 
    SECONDS_TO_DAYS
};

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    #[account(mut)]
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        close = contributor,
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
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> Refund<'info> {
    pub fn refund(&mut self) -> Result<()> {

        let current_time = Clock::get()?.unix_timestamp;
        let time_ended = (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS >= self.fundraiser.duration as i64;
 
        // Can refund if time has ended OR if maker cancelled early
        require!(
            time_ended || self.fundraiser.cancelled,
            crate::FundraiserError::FundraiserNotEnded
        );

        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            crate::FundraiserError::TargetMet
        );

        let cpi_program = self.token_program.key();

        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.contributor_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);

        transfer(cpi_ctx, self.contributor_account.amount)?;

        self.fundraiser.current_amount -= self.contributor_account.amount;

        // If this is the absolute last refund, close the vault and the fundraiser PDA
        if self.vault.amount == self.contributor_account.amount {
            let close_cpi_accounts = CloseAccount {
                account: self.vault.to_account_info(),
                destination: self.maker.to_account_info(),
                authority: self.fundraiser.to_account_info(),
            };
            let close_cpi_ctx = CpiContext::new_with_signer(self.token_program.key(), close_cpi_accounts, &signer_seeds);
            close_account(close_cpi_ctx)?;

            // Close the fundraiser PDA manually
            self.fundraiser.close(self.maker.to_account_info())?;
        }

        Ok(())
    }
}