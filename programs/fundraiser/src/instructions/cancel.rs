use anchor_lang::prelude::*;

use crate::{state::Fundraiser, FundraiserError, SECONDS_TO_DAYS};

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(
        mut,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
        constraint = fundraiser.maker == maker.key()
    )]
    pub fundraiser: Account<'info, Fundraiser>,
}

impl<'info> Cancel<'info> {
    pub fn cancel(&mut self) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;

        // Can only cancel if time has not ended
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                < self.fundraiser.duration as i64,
            FundraiserError::FundraiserEnded
        );

        // Can only cancel if target has not been met (technically check_contributions would have fired)
        require!(
            !self.fundraiser.target_met,
            FundraiserError::TargetMet
        );

        self.fundraiser.cancelled = true;

        Ok(())
    }
}
