use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64,
    pub receipt_minted: bool,  // ADDED FOR NFT FEAT

}