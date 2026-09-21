use anchor_lang::prelude::*;
use anchor_spl::token::{
    burn, close_account, transfer, Burn, CloseAccount, Mint, Token, TokenAccount, Transfer,
};

use crate::{
    state::{Contributor, Fundraiser},
    SECONDS_TO_DAYS,
};

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    #[account(mut)]
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Box<Account<'info, Mint>>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [b"shares", fundraiser.key().as_ref()],
        bump,
    )]
    pub ownership_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        close = contributor,
    )]
    pub contributor_account: Option<Account<'info, Contributor>>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = contributor
    )]
    pub contributor_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = ownership_mint,
        associated_token::authority = contributor
    )]
    pub contributor_ownership_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = ownership_mint,
        associated_token::authority = fundraiser
    )]
    pub ownership_vault: Box<Account<'info, TokenAccount>>,
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

        // Refund whatever shares this wallet holds, not what it originally contributed.
        // Read once before any CPI: the deserialized account does not update after a transfer.
        let contributor_ownership_amount = self.contributor_ownership_ata.amount;

        require!(
            contributor_ownership_amount > 0,
            crate::FundraiserError::NoSharesToReturn
        );

        // Tear down only if this payout leaves the vault truly empty. Tokens sent
        // straight to the vault ATA would otherwise make close_account fail and
        // block the last refund forever.
        let vault_empty_after = self.vault.amount == contributor_ownership_amount;

        // Return the ownership shares to the share vault, signed by the contributor.
        // As of Anchor 1.0 a CpiContext takes the program's address, not its AccountInfo.
        let cpi_program = self.token_program.key();

        let cpi_accounts = Transfer {
            from: self.contributor_ownership_ata.to_account_info(),
            to: self.ownership_vault.to_account_info(),
            authority: self.contributor.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(self.token_program.key(), cpi_accounts);

        transfer(cpi_ctx, contributor_ownership_amount)?;

        // Pay out one raise token per share returned, from the vault to the contributor
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

        transfer(cpi_ctx, contributor_ownership_amount)?;

        // Shares are conserved (fixed supply), so this cannot underflow
        self.fundraiser.current_amount = self
            .fundraiser
            .current_amount
            .checked_sub(contributor_ownership_amount)
            .ok_or(crate::FundraiserError::Underflow)?;

        // Every share is back, so nobody is owed anything: burn the supply,
        // close both vaults, then close the fundraiser
        if self.fundraiser.current_amount == 0 && vault_empty_after {
            burn(
                CpiContext::new_with_signer(
                    self.token_program.key(),
                    Burn {
                        mint: self.ownership_mint.to_account_info(),
                        from: self.ownership_vault.to_account_info(),
                        authority: self.fundraiser.to_account_info(),
                    },
                    &signer_seeds,
                ),
                self.fundraiser.amount_to_raise,
            )?;

            close_account(CpiContext::new_with_signer(
                self.token_program.key(),
                CloseAccount {
                    account: self.ownership_vault.to_account_info(),
                    destination: self.maker.to_account_info(),
                    authority: self.fundraiser.to_account_info(),
                },
                &signer_seeds,
            ))?;
            close_account(CpiContext::new_with_signer(
                self.token_program.key(),
                CloseAccount {
                    account: self.vault.to_account_info(),
                    destination: self.maker.to_account_info(),
                    authority: self.fundraiser.to_account_info(),
                },
                &signer_seeds,
            ))?;

            self.fundraiser.close(self.maker.to_account_info())?;
        }
        Ok(())
    }
}
