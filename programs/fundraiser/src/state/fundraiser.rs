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
    /// Bit i is set once the campaign has ever touched MILESTONE_PERCENTS[i].
    /// Latched: a refund lowers `current_amount`, but never clears a bit.
    pub milestones_reached: u8,
    /// Bit i is set once the maker has acknowledged milestone i.
    /// This is the flag that keeps the announcement from firing twice.
    pub milestones_announced: u8,
}
