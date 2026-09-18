use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken, 
    token::{
        transfer,
        
        Mint, 
        Token, 
        TokenAccount, 
        Transfer
    }
};

use crate::{
    state::Fundraiser, 
    FundraiserError,
    SECONDS_TO_DAYS
};

#[derive(Accounts)]
pub struct CheckContributions<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"fundraiser".as_ref(), maker.key().as_ref(), &fundraiser.id.to_le_bytes()],
        bump = fundraiser.bump,
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

        // The book has to be shut before it can be cleared. Without this a maker
        // could settle the instant bids crossed the target, which puts the race
        // straight back: whoever triggers settlement freezes out every later bid
        // and fixes the fill ratio in their own favour.
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                >= self.fundraiser.duration as i64,
            FundraiserError::FundraiserNotEnded
        );

        require!(!self.fundraiser.settled, FundraiserError::AlreadySettled);

        // Read the order book, not the vault.
        //
        // The vault is an ordinary ATA that anyone may transfer into, so
        // `vault.amount` is attacker-controlled. It used to be what decided
        // whether the target was met — which meant a campaign with no
        // contributions at all could pay out. Now that the same number would
        // also be the denominator of everyone's fill, reading it here would let
        // a stranger dilute every contributor and walk off with their excess.
        require!(
            self.fundraiser.current_amount >= self.fundraiser.amount_to_raise,
            FundraiserError::TargetNotMet
        );

        // Transfer the funds to the maker
        // CPI to the token program to transfer the funds
        // As of Anchor 1.0 a CpiContext takes the program's address, not its AccountInfo.
        let cpi_program = self.token_program.key();

        // Transfer the funds from the vault to the maker
        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.maker_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        // Signer seeds to sign the CPI on behalf of the fundraiser account
        let id_bytes = self.fundraiser.id.to_le_bytes();
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            id_bytes.as_ref(),
            &[self.fundraiser.bump],
        ]];

        // CPI context with signer since the fundraiser account is a PDA
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);

        // Exactly the target. Never the whole vault.
        //
        // Everything above `amount_to_raise` belongs to the contributors who
        // oversubscribed, and they take it back through `claim_excess`. A maker
        // who wanted more should have asked for more — which is precisely what
        // the oversubscription ratio now tells them to do next time.
        transfer(cpi_ctx, self.fundraiser.amount_to_raise)?;

        // Freeze the denominator. Claimers drain `current_amount` on their way
        // out, so the fill ratio has to be computed against the book as it stood
        // when it shut, not against whatever is left of it.
        self.fundraiser.settled_total = self.fundraiser.current_amount;
        self.fundraiser.settled = true;

        // Neither the vault nor the fundraiser is closed here any more: the
        // vault still owes the oversubscribed their excess, and the fundraiser
        // holds the numbers needed to work out how much. `close_campaign` winds
        // both up once the last claim is in.
        Ok(())
    }
}