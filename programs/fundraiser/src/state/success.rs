use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Success {
    pub fundraiser: Pubkey,
    pub maker: Pubkey,
    pub reward_mint: Pubkey,
    pub fundraiser_bump: u8,
    pub bump: u8,
}
