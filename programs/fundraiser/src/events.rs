use anchor_lang::prelude::*;

#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    pub quarter: u8,
    pub amount: u64,
}
