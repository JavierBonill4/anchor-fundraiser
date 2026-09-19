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
    /// One bit per milestone that has already fired:
    /// bit 0 = 25%, bit 1 = 50%, bit 2 = 75%.
    pub milestones_fired: u8,
}
