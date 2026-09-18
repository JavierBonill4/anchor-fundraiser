use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer, 
    Mint, 
    Token, 
    TokenAccount, 
    Transfer
};

use crate::{
    state::{
        Contributor, 
        Fundraiser
    }, 
    FundraiserError,
    SECONDS_TO_DAYS
};

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", maker.key().as_ref(), &fundraiser.id.to_le_bytes()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [
            b"contributor",
            fundraiser.key().as_ref(),
            contributor.key().as_ref(),
            &fundraiser.time_started.to_le_bytes(),
        ],
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

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
 
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                >= self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserNotEnded
        );

        // Two conditions, and both are load-bearing.
        //
        // `!settled` is the one the vault balance used to stand in for. Once
        // `claim_excess` starts draining the vault, a settled campaign's balance
        // falls back below the target — and a check against the vault would wave
        // through a refund on money the maker had already been paid. Two routes
        // to the same tokens is a double spend.
        //
        // `current_amount < amount_to_raise` is the original rule, and dropping
        // it on its own was a griefing hole. Between the deadline and the
        // maker's settlement both instructions are otherwise legal at once, so a
        // single bidder on an oversubscribed book could refund, drag the book
        // under the target, and leave `check_contributions` failing TargetNotMet
        // forever — `settled` is only ever set inside that instruction, so there
        // is no way back. One participant could veto a fully funded raise.
        require!(
            !self.fundraiser.settled
                && self.fundraiser.current_amount < self.fundraiser.amount_to_raise,
            FundraiserError::TargetMet
        );

        // Transfer the funds back to the contributor
        // CPI to the token program to transfer the funds
        // As of Anchor 1.0 a CpiContext takes the program's address, not its AccountInfo.
        let cpi_program = self.token_program.key();

        // Transfer the funds from the vault to the contributor
        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.contributor_ata.to_account_info(),
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

        // Transfer the funds from the vault to the contributor
        transfer(cpi_ctx, self.contributor_account.amount)?;

        // Leaving the book. `close_campaign` waits for this to reach zero.
        self.fundraiser.current_amount = self
            .fundraiser
            .current_amount
            .checked_sub(self.contributor_account.amount)
            .ok_or(FundraiserError::Overflow)?;

        Ok(())
    }
}