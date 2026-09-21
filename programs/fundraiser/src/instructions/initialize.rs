use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken, 
    token::{
        Mint, 
        Token, 
        TokenAccount
    }
};

use crate::{
    state::{Fundraiser, FundraiserState}, FundraiserError, ANCHOR_DISCRIMINATOR, MIN_AMOUNT_TO_RAISE
};

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
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> Initialize<'info> {
    pub fn initialize(&mut self, amount: u64, duration: u8, bumps: &InitializeBumps) -> Result<()> {

        // Check if the amount to raise meets the minimum amount required.
        //
        // MIN_AMOUNT_TO_RAISE is a count of whole tokens, so it has to be scaled by
        // the mint's decimals to become a raw amount. `MIN.pow(decimals)` was doing
        // something else entirely: 3.pow(6) is 729, or 0.000729 of a token.
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::InvalidAmount)?;
        let minimum = MIN_AMOUNT_TO_RAISE
            .checked_mul(one_token)
            .ok_or(FundraiserError::InvalidAmount)?;

        require!(amount > minimum, FundraiserError::InvalidAmount);

        // Initialize the fundraiser account
        self.fundraiser.set_inner(Fundraiser {
            maker: self.maker.key(),
            mint_to_raise: self.mint_to_raise.key(),
            amount_to_raise: amount,
            current_amount: 0,
            time_started: Clock::get()?.unix_timestamp,
            duration,
            bump: bumps.fundraiser,
            // New underwriting fields
            state: FundraiserState::Active,
            original_shortfall: 0,
            total_underwritten: 0,
            total_outstanding_claims: 0,
            underwriting_deadline: 0,
        });
        
        Ok(())
    }
}