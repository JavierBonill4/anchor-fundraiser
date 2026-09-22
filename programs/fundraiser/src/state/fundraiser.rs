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
    /// Set by `cancel_fundraiser`. A cancelled campaign takes no further
    /// contributions, and its contributors may refund without waiting for the
    /// duration to run out — the money is theirs again the moment the maker
    /// admits the campaign is over.
    pub cancelled: bool,
}
