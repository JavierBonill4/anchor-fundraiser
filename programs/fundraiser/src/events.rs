use anchor_lang::prelude::*;

#[event]
pub struct MilestoneReached {
    /// Which fundraiser crossed the line.
    pub fundraiser: Pubkey,
    /// 1, 2 or 3 — a quarter, a half, three quarters.
    pub quarter: u8,
    /// The vault total that tripped it. Not necessarily exactly on the
    /// mark: a contribution can jump past one.
    pub current_amount: u64,
    /// Repeated so a listener does not have to fetch the account to
    /// compute a percentage.
    pub amount_to_raise: u64,
    /// When it happened, from the on-chain clock.
    pub timestamp: i64,
}
