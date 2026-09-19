use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64,
    pub rewards_minted: u64,     // appended 
}
