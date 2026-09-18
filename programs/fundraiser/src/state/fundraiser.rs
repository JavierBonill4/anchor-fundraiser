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
    // One bit per quarter-mark the campaign has crossed:
    //   bit 0 (0b001) = 25% of target reached
    //   bit 1 (0b010) = 50% of target reached
    //   bit 2 (0b100) = 75% of target reached
    // Append-only: a refund that lowers current_amount does not clear a bit.
    pub milestones_fired: u8,
}