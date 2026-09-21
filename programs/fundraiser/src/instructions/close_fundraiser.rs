use anchor_lang::prelude::*;
use anchor_spl::token::{close_account, CloseAccount, Mint, Token, TokenAccount};

use crate::{state::Fundraiser, FundraiserError};

#[derive(Accounts)]
pub struct CloseFundraiser<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = maker,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
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
}

impl<'info> CloseFundraiser<'info> {
    pub fn close_fundraiser(&self) -> Result<()> {
        require!(self.fundraiser.is_claimed, FundraiserError::CampaignNotClaimed);
        require!(
            self.fundraiser.badges_minted == self.fundraiser.contributor_count,
            FundraiserError::BadgesOutstanding
        );
        require!(self.vault.amount == 0, FundraiserError::VaultNotEmpty);

        let maker = self.maker.key();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"fundraiser",
            maker.as_ref(),
            &[self.fundraiser.bump],
        ]];

        close_account(CpiContext::new_with_signer(
            self.token_program.key(),
            CloseAccount {
                account: self.vault.to_account_info(),
                destination: self.maker.to_account_info(),
                authority: self.fundraiser.to_account_info(),
            },
            signer_seeds,
        ))?;

        Ok(())
    }
}