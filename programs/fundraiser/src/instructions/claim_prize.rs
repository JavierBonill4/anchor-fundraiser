use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer,
    Token,
    TokenAccount,
    Transfer,
};

use crate::{
    state::{Contributor, Fundraiser},
    error::FundraiserError,
};

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"fundraiser".as_ref(), fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        seeds = [b"contributor", fundraiser.key().as_ref(), winner.key().as_ref()],
        bump,
    )]
    pub contributor_account: Account<'info, Contributor>,
    #[account(
        mut,
        associated_token::mint = fundraiser.mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = fundraiser.mint_to_raise,
        associated_token::authority = winner,
    )]
    pub winner_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

impl<'info> ClaimPrize<'info> {
    pub fn claim_prize(&mut self) -> Result<()> {
        // Enforce that a winner has been drawn
        require!(
            self.fundraiser.winner_drawn,
            FundraiserError::WinnerNotDrawn
        );

        // Enforce that the prize has not already been claimed
        require!(
            !self.fundraiser.prize_claimed,
            FundraiserError::PrizeAlreadyClaimed
        );

        // Verify that the caller holds the winning ticket range
        let winning = self.fundraiser.winning_ticket;
        require!(
            winning >= self.contributor_account.ticket_start
                && winning < self.contributor_account.ticket_end,
            FundraiserError::NotWinningTicket
        );

        // Calculate a 10% slice of the pot for the raffle winner
        let prize_amount = (self.fundraiser.current_amount * 10) / 100;
        let prize_to_transfer = prize_amount.min(self.vault.amount);

        if prize_to_transfer > 0 {
            let cpi_program = self.token_program.key();
            let cpi_accounts = Transfer {
                from: self.vault.to_account_info(),
                to: self.winner_ata.to_account_info(),
                authority: self.fundraiser.to_account_info(),
            };

            let signer_seeds: [&[&[u8]]; 1] = [&[
                b"fundraiser".as_ref(),
                self.fundraiser.maker.as_ref(),
                &[self.fundraiser.bump],
            ]];

            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);
            transfer(cpi_ctx, prize_to_transfer)?;
        }

        self.fundraiser.prize_claimed = true;

        emit!(PrizeClaimed {
            fundraiser: self.fundraiser.key(),
            winner: self.winner.key(),
            winning_ticket: winning,
            prize_amount: prize_to_transfer,
        });

        Ok(())
    }
}

#[event]
pub struct PrizeClaimed {
    pub fundraiser: Pubkey,
    pub winner: Pubkey,
    pub winning_ticket: u64,
    pub prize_amount: u64,
}
