use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{mint_to, Mint, MintTo, Token, TokenAccount},
};

use crate::{state::Fundraiser, FundraiserError, ANCHOR_DISCRIMINATOR, MIN_AMOUNT_TO_RAISE};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    pub mint_to_raise: Account<'info, Mint>,

    #[account(
        init,
        payer = maker,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump,
        space = ANCHOR_DISCRIMINATOR + Fundraiser::INIT_SPACE,
    )]
    pub fundraiser: Account<'info, Fundraiser>,

    #[account(
        init,
        payer = maker,
        mint::decimals = mint_to_raise.decimals,
        mint::authority = fundraiser,
    )]
    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = maker,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = maker,
        associated_token::mint = reward_mint,
        associated_token::authority = fundraiser,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> Initialize<'info> {
    pub fn initialize(
        &mut self,
        amount: u64,
        duration: u8,
        reward_amount: u64,
        bumps: &InitializeBumps,
    ) -> Result<()> {
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::InvalidAmount)?;

        let minimum = MIN_AMOUNT_TO_RAISE
            .checked_mul(one_token)
            .ok_or(FundraiserError::InvalidAmount)?;

        require!(amount > minimum, FundraiserError::InvalidAmount);

        require!(reward_amount == amount, FundraiserError::InvalidAmount);

        self.fundraiser.set_inner(Fundraiser {
            maker: self.maker.key(),
            mint_to_raise: self.mint_to_raise.key(),
            amount_to_raise: amount,
            current_amount: 0,
            time_started: Clock::get()?.unix_timestamp,
            duration,
            bump: bumps.fundraiser,
            reward_mint: self.reward_mint.key(),
            reward_amount,
        });

        let maker_key = self.maker.key();

        let signer_seeds: &[&[&[u8]]] =
            &[&[b"fundraiser", maker_key.as_ref(), &[bumps.fundraiser]]];

        let cpi_accounts = MintTo {
            mint: self.reward_mint.to_account_info(),
            to: self.reward_vault.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let cpi_ctx =
            CpiContext::new_with_signer(self.token_program.key(), cpi_accounts, signer_seeds);

        mint_to(cpi_ctx, reward_amount)?;

        Ok(())
    }
}
