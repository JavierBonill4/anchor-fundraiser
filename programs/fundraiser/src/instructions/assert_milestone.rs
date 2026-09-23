use anchor_lang::prelude::*;

use crate::{
    state::Fundraiser, 
    FundraiserError, 
    MILESTONE_QUARTERS
};

#[derive(Accounts)]
pub struct AssertMilestone<'info> {
    #[account(
        seeds = [b"fundraiser".as_ref(), fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
}

impl<'info> AssertMilestone<'info> {
    pub fn assert_milestone(&self, quarter: u8) -> Result<()> {

        // Map the quarter to its bit in milestones_fired
        let index = MILESTONE_QUARTERS
            .iter()
            .position(|q| *q == quarter)
            .ok_or(FundraiserError::InvalidMilestone)?;

        // Read the fired bit, not current_amount: a milestone stays reached
        // even after refunds lower the total.
        require!(
            self.fundraiser.milestones_fired & (1u8 << index) != 0,
            FundraiserError::MilestoneNotReached
        );

        Ok(())
    }
}
