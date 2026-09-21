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
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        // feat/contribution-receipts: this account used to be closed here.
        // It now survives the refund, so the claimed flag on it stays honest:
        // a record that died would let a refunded contributor re-contribute
        // later and mint a second badge. Instead the record is emptied —
        // amount is zeroed by the handler — and stays behind at its full size.
        // It is inert: refund runs a second time and just fails the NothingTo
        // Refund check, and contribute re-activates it if the owner returns.
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

        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            crate::FundraiserError::TargetMet
        );

        // feat/contribution-receipts: the record is emptied rather than
        // closed, so the claimed flag below it survives the refund. This
        // guard keeps a second refund an explicit failure instead of a silent
        // zero-token transfer: a record exists only if `contribute` (or
        // `claim_receipt`'s init_if_needed) created it, and its amount is
        // positive exactly while something remains to refund.
        require!(
            self.contributor_account.amount > 0,
            crate::FundraiserError::NothingToRefund
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
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        // CPI context with signer since the fundraiser account is a PDA
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);

        // Transfer the funds from the vault to the contributor
        transfer(cpi_ctx, self.contributor_account.amount)?;

        // Update the fundraiser state by reducing the amount contributed.
        // feat/contribution-receipts: the Contributor record is emptied, not
        // closed, so its claimed flag survives the refund — see the account
        // constraint above.
        self.fundraiser.current_amount = self
            .fundraiser
            .current_amount
            .checked_sub(self.contributor_account.amount)
            .ok_or(crate::FundraiserError::NothingToRefund)?;

        self.contributor_account.amount = 0;

        Ok(())
    }
}