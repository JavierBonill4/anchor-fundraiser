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
    /// Set when the maker cancels the campaign early.
    ///
    /// Appended last so every existing field keeps its byte offset; anything
    /// reading this account at a fixed offset is unaffected.
    pub cancelled: bool,
}