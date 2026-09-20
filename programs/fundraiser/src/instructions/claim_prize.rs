use anchor_lang::prelude::*;

use crate::{state::{Contributor, Fundraiser}, FundraiserError, PrizeClaimed};

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    pub claimant: Signer<'info>,
    #[account(
        mut,
        seeds = [b"fundraiser", fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        seeds = [b"contributor", fundraiser.key().as_ref(), claimant.key().as_ref()],
        bump,
    )]
    pub contributor_account: Account<'info, Contributor>,
}

impl<'info> ClaimPrize<'info> {
    pub fn claim_prize(&mut self) -> Result<()> {
        require!(self.fundraiser.drawn, FundraiserError::NotDrawn);
        require!(
            !self.fundraiser.prize_claimed,
            FundraiserError::PrizeAlreadyClaimed
        );
        require!(
            self.contributor_account.ticket_end > self.contributor_account.ticket_start,
            FundraiserError::NoTickets
        );

        let t = self.fundraiser.winning_ticket;
        require!(
            t >= self.contributor_account.ticket_start
                && t < self.contributor_account.ticket_end,
            FundraiserError::NotAWinner
        );

        self.fundraiser.prize_claimed = true;

        emit!(PrizeClaimed {
            fundraiser: self.fundraiser.key(),
            winner: self.claimant.key(),
            winning_ticket: t,
        });
        Ok(())
    }
}
