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
    // Appended at the end so Borsh layout remains stable for existing accounts.
    // Bit 0 = 25%, bit 1 = 50%, bit 2 = 75%. This is a one-way flag set once
    // a threshold is crossed; refunds do not un-fire a milestone.
    pub milestones_fired: u8,
}
