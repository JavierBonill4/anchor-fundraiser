use anchor_lang::prelude::*;
use crate::{state::{Contributor, Fundraiser}, FundraiserError};

#[derive(Accounts)]
pub struct CleanupContributor<'info> {
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
        close = contributor, // Rent returns to contributor
    )]
    pub contributor_account: Account<'info, Contributor>,
}

impl<'info> CleanupContributor<'info> {
    pub fn cleanup(&mut self) -> Result<()> {
        // Can only cleanup after the target is met
        require!(
            self.fundraiser.target_met,
            FundraiserError::TargetNotMet
        );

        // Account closes and rent is returned automatically by Anchor's `close` attribute.
        Ok(())
    }
}
