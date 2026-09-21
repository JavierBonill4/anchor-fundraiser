use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Fundraiser {
    pub maker: Pubkey,
    pub mint_to_raise: Pubkey,
    pub amount_to_raise: u64,
    pub current_amount: u64,
    pub time_started: i64,
    pub duration: u8,
    pub bump: u8,
    // ponytail: bits 0,1,2 = 25%, 50%, 75% milestones reached; set permanently, never cleared on refund
    pub milestone_flags: u8,
}

#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    pub milestone_bps: u16, // 2500, 5000, 7500
}