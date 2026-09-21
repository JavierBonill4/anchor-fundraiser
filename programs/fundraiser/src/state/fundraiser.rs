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
    /// Bitmask of quarter milestones that have fired. Bit 0 = 25%, bit 1 =
    /// 50%, bit 2 = 75%. Appended at the end so existing Borsh layouts only
    /// gain trailing bytes. One-way: a refund never clears a bit.
    pub milestones_fired: u8,
}

/// Emitted once per quarter mark, the first time a contribution pushes the
/// vault at or past it. A front end can subscribe instead of polling the
/// vault balance. Events are logs, not state — the bit in
/// `milestones_fired` is the on-chain record.
#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    /// 1, 2 or 3 — meaning 25%, 50% and 75% of `amount_to_raise`.
    pub quarter: u8,
    /// `current_amount` right after the contribution that fired it.
    pub amount: u64,
}