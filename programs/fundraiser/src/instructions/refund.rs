use anchor_lang::prelude::*;
use anchor_spl::token::{
    burn,
    close_account,
    transfer,
    Burn,
    CloseAccount,
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
    // Same receipt mint created in `contribute` — referenced here, not created.
    #[account(
        mut,
        seeds = [b"receipt", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
    )]
    pub receipt_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = receipt_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_receipt_ata: Account<'info, TokenAccount>,
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

        // Clean up the one-time NFT receipt on refund — best-effort, not required.
        //
        // A contributor could send the receipt to another wallet before calling
        // refund, leaving this ATA at 0 balance. Burning is only possible if they
        // still hold it, and this refund must succeed either way: making the burn
        // mandatory would let a contributor (or an attacker) permanently lock their
        // own refund behind an NFT they no longer have. So: burn only if they still
        // hold it, then close the ATA regardless (closing only requires 0 balance,
        // which is true either way by this point).
        if self.contributor_receipt_ata.amount > 0 {
            let burn_cpi_accounts = Burn {
                mint: self.receipt_mint.to_account_info(),
                from: self.contributor_receipt_ata.to_account_info(),
                authority: self.contributor.to_account_info(),
            };
            let burn_cpi_ctx = CpiContext::new(self.token_program.key(), burn_cpi_accounts);
            burn(burn_cpi_ctx, 1)?;
        }

        // Close the now-empty receipt ATA and reclaim its rent back to the contributor.
        // Note: the receipt *mint* itself can't be closed by the standard token
        // program (only token accounts can), so its rent stays locked up forever.
        let close_cpi_accounts = CloseAccount {
            account: self.contributor_receipt_ata.to_account_info(),
            destination: self.contributor.to_account_info(),
            authority: self.contributor.to_account_info(),
        };
        let close_cpi_ctx = CpiContext::new(self.token_program.key(), close_cpi_accounts);
        close_account(close_cpi_ctx)?;

        Ok(())
    }
}