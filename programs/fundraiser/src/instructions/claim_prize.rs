use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{transfer, Mint, Token, TokenAccount, Transfer},
};

use crate::{
    state::{Contributor, Fundraiser},
    FundraiserError,
};

/// The winner collects the overshoot. The program never learns who won — it
/// cannot enumerate Contributor PDAs — so the holder proves it with their own.
#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    #[account(mut)]
    pub winner: Signer<'info>,
    /// Receives the fundraiser's rent; bound by the PDA seeds below.
    #[account(mut)]
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = maker,
        has_one = mint_to_raise,
        seeds = [b"fundraiser".as_ref(), maker.key().as_ref()],
        bump = fundraiser.bump,
        close = maker,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), winner.key().as_ref()],
        bump,
        close = winner,
    )]
    pub contributor_account: Account<'info, Contributor>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = winner,
        associated_token::mint = mint_to_raise,
        associated_token::authority = winner,
    )]
    pub winner_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> ClaimPrize<'info> {
    pub fn claim_prize(&mut self) -> Result<()> {
        require!(self.fundraiser.drawn, FundraiserError::NotDrawn);

        // Half open. `<=` on the upper edge would let two neighbours both claim the
        // boundary number.
        let winning = self.fundraiser.winning_ticket;
        require!(
            self.contributor_account.ticket_start <= winning
                && winning < self.contributor_account.ticket_end,
            FundraiserError::NotWinningTicket
        );

        // Whatever is left after the maker took the target. Read from the vault so a
        // stray transfer into it cannot be stranded behind a closed account.
        let prize = self.vault.amount;

        if prize > 0 {
            let cpi_accounts = Transfer {
                from: self.vault.to_account_info(),
                to: self.winner_ata.to_account_info(),
                authority: self.fundraiser.to_account_info(),
            };

            let signer_seeds: [&[&[u8]]; 1] = [&[
                b"fundraiser".as_ref(),
                self.maker.to_account_info().key.as_ref(),
                &[self.fundraiser.bump],
            ]];

            transfer(
                CpiContext::new_with_signer(
                    self.token_program.key(),
                    cpi_accounts,
                    &signer_seeds,
                ),
                prize,
            )?;
        }

        // A second call cannot load the closed Fundraiser, so `close` is the guard
        // here. That is sound only because the account is a required input; where it
        // survives the call, `drawn` is an explicit flag instead.
        msg!("Prize of {} claimed on ticket {}", prize, winning);

        Ok(())
    }
}
