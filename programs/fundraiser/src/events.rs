use anchor_lang::prelude::*;

/// Emitted once per quarter mark (25%, 50%, 75%) the first time a
/// contribution pushes `current_amount` past it. A front end can subscribe
/// to this instead of polling the vault balance.
///
/// Idempotency lives in `Fundraiser::milestones_fired`, not here — this
/// event is a side effect of that bitflag flipping, so it can only ever be
/// emitted once per mark per fundraiser. See instructions/contribute.rs.
#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    /// 25, 50 or 75.
    pub milestone_percent: u8,
    pub current_amount: u64,
    pub amount_to_raise: u64,
}
