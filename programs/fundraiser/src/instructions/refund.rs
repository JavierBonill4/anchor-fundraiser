use anchor_lang::prelude::*;
use anchor_spl::token::{burn, transfer, Burn, Mint, Token, TokenAccount, Transfer};

use crate::{
    state::{Contributor, Fundraiser},
    SECONDS_TO_DAYS,
};

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"receipt", maker.key().as_ref()],
        bump = fundraiser.receipt_bump
    )]
    pub receipt_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        has_one = mint_to_raise,
        has_one = receipt_mint,
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
        associated_token::mint = receipt_mint,
        associated_token::authority = contributor
    )]
    pub contributor_receipt_ata: Box<Account<'info, TokenAccount>>,
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

        let cpi_accounts = Burn {
            mint: self.receipt_mint.to_account_info(),
            from: self.contributor_receipt_ata.to_account_info(),
            authority: self.contributor.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let one_receipt_token = 10u128
            .checked_pow(self.receipt_mint.decimals as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let amount_to_burn: u64 = (self.contributor_account.amount as u128)
            .checked_mul(one_receipt_token)
            .ok_or(ProgramError::ArithmeticOverflow)?
            .checked_div(one_token as u128)
            .ok_or(ProgramError::ArithmeticOverflow)?
            .try_into()?;
        // This may fail if user transferred this to third-account and user money can get locked
        // Better version is where protocol enforces rules for receipt_token using token2022
        // But this one works for the scope of course
        burn(cpi_ctx, amount_to_burn)?;

        // Update the fundraiser state by reducing the amount contributed
        self.fundraiser.current_amount -= self.contributor_account.amount;

        Ok(())
    }
}
