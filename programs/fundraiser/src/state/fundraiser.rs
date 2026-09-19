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
    /// The reward-token mint this fundraiser created and controls. One per
    /// campaign, authority = the fundraiser PDA itself. `contribute` mints
    /// from it 1:1 with every contribution; nothing else may.
    pub reward_mint: Pubkey,
}
