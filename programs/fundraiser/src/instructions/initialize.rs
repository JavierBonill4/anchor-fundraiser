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
    ANCHOR_DISCRIMINATOR, BOND_LAMPORTS, MIN_AMOUNT_TO_RAISE, REVEAL_WINDOW,SECONDS_TO_DAYS, error::FundraiserError, state::{Fundraiser, Bond}
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
    #[account(
        init,
        payer = maker,
        space = ANCHOR_DISCRIMINATOR + Bond::INIT_SPACE,
        seeds = [b"bond", fundraiser.key().as_ref()],
        bump,
    )]
    pub bond:  Account<'info, Bond>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> Initialize<'info> {
    pub fn initialize(&mut self, amount: u64, duration: u8,reveal_hash:[u8; 32], reward_bps: u16, bumps: &InitializeBumps) -> Result<()> {

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

        let time_started = Clock::get()?.unix_timestamp;

        let window_close = time_started
            .checked_add((duration as i64).checked_mul(SECONDS_TO_DAYS).ok_or(FundraiserError::Overflow)?)
            .ok_or(FundraiserError::Overflow)?;
        let reveal_deadline: i64 = window_close
            .checked_add(REVEAL_WINDOW)
            .ok_or(FundraiserError::Overflow)?;

        // Initialize the fundraiser account
        self.fundraiser.set_inner(Fundraiser {
            maker: self.maker.key(),
            mint_to_raise: self.mint_to_raise.key(),
            amount_to_raise: amount,
            current_amount: 0,
            time_started: Clock::get()?.unix_timestamp,
            duration,
            bump: bumps.fundraiser,
            reveal_hash,
            reward_bps,
            total_tickets: 0,
            winner_drawn: false,
            reveal_deadline,
        });

        self.bond.set_inner(Bond {
            fundraiser: self.fundraiser.key(),
            bump: bumps.bond,
        });
        let cpi_ctx = CpiContext::new(
            self.system_program.key(),
            anchor_lang::system_program::Transfer{
                from: self.maker.to_account_info(),
                to: self.bond.to_account_info(),
            },
        );

        anchor_lang::system_program::transfer( cpi_ctx, BOND_LAMPORTS)?;
        
        Ok(())
    }
}