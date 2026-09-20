use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64,
    pub is_early_investor: bool,
    pub nft_claimed: bool,
}