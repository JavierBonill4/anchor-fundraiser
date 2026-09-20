use anchor_lang::prelude::*;

use crate::{
    state::Fundraiser, FundraiserError, DEFAULT_CONTRIBUTION_CAP_PERCENTAGE,
    MIN_CONTRIBUTION_CAP_PERCENTAGE,
};

#[derive(Accounts)]
pub struct SetContributionCap<'info> {
    pub maker: Signer<'info>,
    #[account(
        mut,
        has_one = maker @ FundraiserError::UnauthorizedMaker,
        seeds = [b"fundraiser", fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
}

impl SetContributionCap<'_> {
    pub fn set_contribution_cap(&mut self, percentage: u8) -> Result<()> {
        require!(
            (MIN_CONTRIBUTION_CAP_PERCENTAGE..=DEFAULT_CONTRIBUTION_CAP_PERCENTAGE)
                .contains(&percentage),
            FundraiserError::InvalidContributionCap
        );
        require!(
            !self.fundraiser.contribution_cap_locked,
            FundraiserError::ContributionCapLocked
        );

        self.fundraiser.contribution_cap_percentage = percentage;

        Ok(())
    }
}
