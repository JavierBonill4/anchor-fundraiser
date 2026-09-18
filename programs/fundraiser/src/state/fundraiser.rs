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
    /// Distinguishes one campaign from the next for the same maker. Appended,
    /// not inserted, so the layout of every field above is unchanged.
    pub id: u64,
    /// Set by `check_contributions`. Once true the book is shut: no more bids,
    /// no refunds, only `claim_excess`.
    pub settled: bool,
    /// `current_amount` frozen at the moment of settlement. This is the
    /// denominator of every fill, so it must not move as claimers drain
    /// `current_amount` on their way out.
    pub settled_total: u64,
}