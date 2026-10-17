use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{close_account, CloseAccount, Mint, Token, TokenAccount}
};

use crate::{state::Fundraiser, FundraiserError};

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
        has_one = maker,
        close = maker,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> Cancel<'info> {
    pub fn cancel(&self) -> Result<()> {
        // Only an empty fundraiser can be cancelled. Once anyone has contributed,
        // the all-or-nothing rules in refund/check_contributions own the funds.
        require!(self.vault.amount == 0, FundraiserError::VaultNotEmpty);

        // The vault is a token account owned by the fundraiser PDA, so the PDA
        // has to sign the close and the rent goes back to the maker.
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        let cpi_accounts = CloseAccount {
            account: self.vault.to_account_info(),
            destination: self.maker.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(self.token_program.key(), cpi_accounts, &signer_seeds);
        close_account(cpi_ctx)?;

        Ok(())
    }
}
