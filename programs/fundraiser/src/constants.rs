pub const ANCHOR_DISCRIMINATOR: usize = 8;
pub const MIN_AMOUNT_TO_RAISE: u64 = 3;
pub const SECONDS_TO_DAYS: i64 = 86400;
pub const MAX_CONTRIBUTION_PERCENTAGE: u64 = 10;
pub const PERCENTAGE_SCALER: u64 = 100;
// Milestones are quarters of the target: quarter q is reached once
// current_amount * QUARTERS_PER_TARGET >= amount_to_raise * q.
// Bit i of Fundraiser.milestones_fired belongs to MILESTONE_QUARTERS[i].
pub const QUARTERS_PER_TARGET: u128 = 4;
pub const MILESTONE_QUARTERS: [u8; 3] = [1, 2, 3];
