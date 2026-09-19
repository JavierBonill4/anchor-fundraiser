use anchor_lang::prelude::*;

#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    /// The reached quarter: 1 = 25%, 2 = 50%, 3 = 75%.
    pub quarter: u8,
    pub amount: u64,
}
