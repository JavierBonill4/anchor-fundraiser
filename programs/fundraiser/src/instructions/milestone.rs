use anchor_lang::prelude::*;

use crate::{state::Fundraiser, FundraiserError, MILESTONE_COUNT};

/// Emitted from `contribute` once per milestone, the first time the vault
/// satisfies it. A front end or indexer can subscribe to this instead of
/// polling the account.
#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    /// 0 = 25%, 1 = 50%, 2 = 75%.
    pub index: u8,
    pub current_amount: u64,
    pub amount_to_raise: u64,
}

/// A transaction-level guard: succeeds only if milestone `index` has fired.
///
/// Read-only and permissionless, no signer beyond the fee payer. Bundle it
/// ahead of any instruction that should only run once a campaign has passed
/// a mark, and the whole transaction fails atomically if it has not.
#[derive(Accounts)]
pub struct CheckMilestone<'info> {
    #[account(
        seeds = [b"fundraiser".as_ref(), fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
}

impl<'info> CheckMilestone<'info> {
    pub fn check_milestone(&self, index: u8) -> Result<()> {
        require!(index < MILESTONE_COUNT, FundraiserError::InvalidMilestone);

        require!(
            self.fundraiser.milestones_fired & (1u8 << index) != 0,
            FundraiserError::MilestoneNotReached
        );

        Ok(())
    }
}
