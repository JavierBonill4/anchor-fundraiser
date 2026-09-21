use anchor_lang::prelude::*;

use crate::{
    state::{Fundraiser, FundraiserState},
};

/// Permissionless crank: anyone can call this to check whether the underwriting
/// phase has expired. If the deadline has passed and the shortfall is NOT fully
/// filled, the state transitions to Failed, which reopens the refund path for
/// original contributors.
///
/// If the shortfall IS fully filled, this is a no-op (the state should already
/// be Underwritten, but this crank is safe to call in any state — it just
/// won't do anything).
///
/// Who calls this and why:
///   - Contributors who want to refund need Failed state.
///   - Any helpful observer can call it.
///   - There is no reward for calling it (pure public good).
#[derive(Accounts)]
pub struct CheckUnderwritingStatus<'info> {
    #[account(
        mut,
        seeds = [b"fundraiser", fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
}

impl<'info> CheckUnderwritingStatus<'info> {
    pub fn check_underwriting_status(&mut self) -> Result<()> {
        // Only meaningful in Underwriting state
        if self.fundraiser.state != FundraiserState::Underwriting {
            return Ok(());
        }

        let current_time = Clock::get()?.unix_timestamp;

        // If underwriting deadline has NOT passed yet, nothing to do
        if current_time < self.fundraiser.underwriting_deadline {
            return Ok(());
        }

        // Deadline passed. Check if shortfall was fully filled.
        if self.fundraiser.total_underwritten >= self.fundraiser.original_shortfall {
            // Should already be Underwritten, but set it explicitly
            self.fundraiser.state = FundraiserState::Underwritten;
        } else {
            // Shortfall not filled -> transition to Failed
            self.fundraiser.state = FundraiserState::Failed;
        }

        Ok(())
    }
}
