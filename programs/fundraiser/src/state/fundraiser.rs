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
    // Appended, not inserted — a field in the middle would shift every byte
    // after it for accounts created before this change. One bit per quarter
    // mark reached (bit 0 = 25%, bit 1 = 50%, bit 2 = 75%); see contribute().
    pub milestones_fired: u8,
}
