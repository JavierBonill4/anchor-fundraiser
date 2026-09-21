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
    pub reveal_hash: [u8; 32],
    pub reward_bps: u16,
    pub total_tickets: u64,
    pub winner_drawn: bool,
    pub reveal_deadline: i64,
}