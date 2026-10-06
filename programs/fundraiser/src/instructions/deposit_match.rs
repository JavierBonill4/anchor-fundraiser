use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount, Transfer, transfer},
};
use crate::state::Fundraiser;

#[derive(Accounts)]
pub struct DepositMatch<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
        has_one = maker,
        has_one = mint_to_raise,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        init_if_needed,
        payer = maker,
        seeds = [b"match", fundraiser.key().as_ref()],
        bump,
        token::mint = mint_to_raise,
        token::authority = fundraiser,
    )]
    pub match_vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = maker,
    )]
    pub maker_ata: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> DepositMatch<'info> {
    pub fn deposit_match(&mut self, amount: u64) -> Result<()> {
        let cpi = CpiContext::new(
            self.token_program.key(),
            Transfer {
                from: self.maker_ata.to_account_info(),
                to: self.match_vault.to_account_info(),
                authority: self.maker.to_account_info(),
            },
        );
        transfer(cpi, amount)?;
        self.fundraiser.match_remaining = self
            .fundraiser
            .match_remaining
            .checked_add(amount)
            .ok_or(crate::FundraiserError::InvalidAmount)?;
        Ok(())
    }
}
