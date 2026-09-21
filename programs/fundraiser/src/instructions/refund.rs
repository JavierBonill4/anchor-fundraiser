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
        // A settled campaign is not refundable. The Fundraiser account used to be
        // closed on settlement, which enforced this for free; it has to survive now.
        // The tally check below happens to cover it too, because settlement does not
        // decrement current_amount — but that is an implementation detail of
        // settlement, and this states the rule.
        require!(!self.fundraiser.drawn, crate::FundraiserError::AlreadyDrawn);

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
 
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                >= self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserNotEnded
        );

        // The program's own tally, not the vault balance: anyone can transfer into
        // the vault, and using it here would let a stranger block every refund.
        require!(
            self.fundraiser.current_amount < self.fundraiser.amount_to_raise,
            crate::FundraiserError::TargetMet
        );

        let cpi_program = self.token_program.key();

        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.contributor_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);

        transfer(cpi_ctx, self.contributor_account.amount)?;

        // `total_tickets` is deliberately left alone: un-issuing a range would leave
        // a gap no live account could prove ownership of. Refunds only happen on a
        // campaign that never drew, so the gaps are never drawn from.
        self.fundraiser.current_amount = self
            .fundraiser
            .current_amount
            .checked_sub(self.contributor_account.amount)
            .ok_or(crate::FundraiserError::MathOverflow)?;

        Ok(())
    }
}