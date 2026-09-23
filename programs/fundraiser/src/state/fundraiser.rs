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
    // Bit i is set once current_amount has reached MILESTONES[i] percent of
    // amount_to_raise. Bits are only ever set, never cleared.
    pub milestones_fired: u8,
}