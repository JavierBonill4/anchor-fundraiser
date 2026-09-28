use anchor_lang::prelude::*;
use anchor_spl::token::{
    burn,
    Burn,
    transfer, 
    Mint, 
    Token, 
    TokenAccount, 
    Transfer
};

use crate::{
    state::{
        Fundraiser,
        Receipt
    },
    FundraiserError,
    SECONDS_TO_DAYS
};


#[derive(Accounts)]
#[instruction(issue_number: u64)]

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
        // The claim record. Seeds rebuilt from the issue number, so it must be the real receipt #N of THIS fundraiser.
    #[account(
        mut,
        seeds = [b"receipt", fundraiser.key().as_ref(), issue_number.to_le_bytes().as_ref()],
        bump = receipt.bump,
        close = contributor,          // delete it after paying, rent goes to whoever redeemed
    )]
    pub receipt: Box<Account<'info, Receipt>>,

    // The NFT's mint, derived from the SAME issue number, so it can't be paired with a different receipt.
    #[account(
        mut,
        seeds = [b"receipt_mint", fundraiser.key().as_ref(), issue_number.to_le_bytes().as_ref()],
        bump,
    )]
    pub receipt_mint: Box<Account<'info, Mint>>,

    // Proof of possession: the signer's token account for that NFT, holding exactly 1.
    #[account(
        mut,
        token::mint = receipt_mint,
        token::authority = contributor,
        constraint = holder_receipt_ata.amount == 1 @ FundraiserError::NoReceipt,
    )]
    pub holder_receipt_ata: Box<Account<'info, TokenAccount>>,

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

                // Burn the receipt NFT first. The holder signs this themselves, so no PDA seeds needed.
        let burn_accounts = Burn {
            mint: self.receipt_mint.to_account_info(),
            from: self.holder_receipt_ata.to_account_info(),
            authority: self.contributor.to_account_info(),
        };
        burn(CpiContext::new(self.token_program.key(), burn_accounts), 1)?;


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
        transfer(cpi_ctx, self.receipt.amount)?;

        // Update the fundraiser state by reducing the amount contributed
        self.fundraiser.current_amount -= self.receipt.amount;

        Ok(())
    }
}
