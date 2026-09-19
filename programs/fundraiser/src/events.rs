use anchor_lang::prelude::*;

#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    pub percentage: u8,
    pub current_amount: u64,
}