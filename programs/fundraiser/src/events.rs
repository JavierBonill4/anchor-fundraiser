use anchor_lang::prelude::*;

#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    pub milestone: u8,
}
