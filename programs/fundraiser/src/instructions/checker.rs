use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken, 
    token::{
        transfer,
        close_account, 
        Mint, 
        Token, 
        TokenAccount, 
        Transfer,
        CloseAccount
    }
};

use crate::{
    state::Fundraiser, 
    FundraiserError
};

#[derive(Accounts)]
pub struct CheckContributions<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"fundraiser".as_ref(), maker.key().as_ref()],
        bump = fundraiser.bump,
        // Removed close = maker to leave it open for contributor cleanup
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = mint_to_raise,
        associated_token::authority = maker,
    )]
    pub maker_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> CheckContributions<'info> {
    pub fn check_contributions(&mut self) -> Result<()> {
        
        // Check if the target amount has been met
        require!(
            self.vault.amount >= self.fundraiser.amount_to_raise,
            FundraiserError::TargetNotMet
        );

        // Transfer the funds to the maker
        let cpi_program = self.token_program.key();

        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.maker_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);

        // Transfer the funds from the vault to the maker
        transfer(cpi_ctx, self.vault.amount)?;

        // Close the vault to recover the rent back to the maker
        let close_cpi_accounts = CloseAccount {
            account: self.vault.to_account_info(),
            destination: self.maker.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let close_cpi_ctx = CpiContext::new_with_signer(self.token_program.key(), close_cpi_accounts, &signer_seeds);
        close_account(close_cpi_ctx)?;

        // Set target_met flag so contributors can safely clean up their accounts
        self.fundraiser.target_met = true;

        Ok(())
    }
}