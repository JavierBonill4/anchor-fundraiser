 use anchor_lang::prelude::*;

#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    pub milestone_pct: u8,
    pub current_amount: u128,
}
