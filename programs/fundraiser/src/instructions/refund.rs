use anchor_lang::prelude::*;
use anchor_spl::{
    token::{
        transfer, 
        Mint, 
        Token, 
        TokenAccount, 
        Transfer
    },
    token_2022::{
        self as token_2022_cpi,
        Burn as T22Burn,
        Token2022,
    },
    token_interface::TokenAccount as InterfaceTokenAccount,
};

use crate::{
    state::{
        Contributor, 
        Fundraiser
    }, 
    RECEIPT_SEED,
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

    /// CHECK: Validated via seeds constraint.
    #[account(
        mut,
        seeds = [RECEIPT_SEED, fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
    )]
    pub receipt_mint: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = receipt_mint,
        associated_token::authority = contributor,
        associated_token::token_program = token_2022_program,
    )]
    pub contributor_receipt_ata: InterfaceAccount<'info, InterfaceTokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,

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

        // ── Burn the contributor's receipt NFT ─────────────────────────
        //
        // This is done before the vault transfer to fail fast: if the burn
        // fails (e.g. they don't have the receipt), we save the compute cost
        // of executing the transfer. However, because the entire instruction
        // is atomic, the order does not change the correctness — if the burn
        // were placed after the transfer and failed, the transfer would be
        // reverted anyway.
        token_2022_cpi::burn(
            CpiContext::new(
                self.token_2022_program.key(),
                T22Burn {
                    mint:      self.receipt_mint.to_account_info(),
                    from:      self.contributor_receipt_ata.to_account_info(),
                    authority: self.contributor.to_account_info(),
                },
            ),
            1, // burn exactly 1 receipt
        )?;

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

        // Update the fundraiser state by reducing the amount contributed
        self.fundraiser.current_amount -= self.contributor_account.amount;

        Ok(())
    }
}