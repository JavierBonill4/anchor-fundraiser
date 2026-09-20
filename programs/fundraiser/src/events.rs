use anchor_lang::prelude::*;

/// Emitted once, the first time a campaign's running total crosses a
/// milestone. A single large contribution can cross several at once, in which
/// case one event is emitted per milestone passed, lowest first.
#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    /// 25, 50 or 75.
    pub percentage: u64,
    /// The running total at the moment it crossed.
    pub current_amount: u64,
    pub amount_to_raise: u64,
}
