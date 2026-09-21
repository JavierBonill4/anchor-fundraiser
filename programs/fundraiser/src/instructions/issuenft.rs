use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{mint_to, MintTo},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{state::{Contributor, Fundraiser}, FundraiserError, SECONDS_TO_DAYS};






#[derive(Accounts)]
pub struct IssueReceipt<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,

    #[account(
        seeds = [b"fundraiser".as_ref(), fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,

    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
    )]
    pub contributor_account: Account<'info, Contributor>,

    #[account(
        init_if_needed,
        payer = contributor,
        seeds = [
            b"receipt-mint",
            fundraiser.key().as_ref(),
            contributor.key().as_ref(),
        ],
        bump,
        mint::token_program = token_program,
        mint::authority = fundraiser,
        mint::decimals = 0,
    )]
    pub receipt_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint = receipt_mint,
        associated_token::authority = contributor,
        associated_token::token_program = token_program,
    )]
    pub contributor_receipt_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}


impl<'info> IssueReceipt<'info> {
    pub fn issue_receipt(&mut self) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;

        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                >= self.fundraiser.duration as i64,
            FundraiserError::FundraiserNotEnded
        );

        require!(
            self.fundraiser.current_amount >= self.fundraiser.amount_to_raise,
            FundraiserError::TargetNotMet
        );

        require!(
            !self.contributor_account.receipt_claimed,
            FundraiserError::ReceiptAlreadyClaimed
        );

        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser",
            self.fundraiser.maker.as_ref(),
            &[self.fundraiser.bump],
        ]];

        let cpi_accounts = MintTo {
            mint: self.receipt_mint.to_account_info(),
            to: self.contributor_receipt_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            self.token_program.key(),
            cpi_accounts,
            &signer_seeds,
        );

        mint_to(cpi_ctx, 1)?;

        self.contributor_account.receipt_claimed = true;

        Ok(())
    }
}