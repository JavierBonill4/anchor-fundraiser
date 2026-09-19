use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64,
    // Set once the one-time NFT receipt has been minted for this contributor,
    // so a second contribution to the same fundraiser doesn't mint a second one.
    pub has_receipt: bool,
}