pub const ANCHOR_DISCRIMINATOR: usize = 8;
pub const MIN_AMOUNT_TO_RAISE: u64 = 3;
pub const SECONDS_TO_DAYS: i64 = 86400;
pub const MAX_CONTRIBUTION_PERCENTAGE: u64 = 10;
pub const PERCENTAGE_SCALER: u64 = 100;

/// Funding milestones fire at 1/4, 2/4 and 3/4 of the target.
pub const MILESTONE_COUNT: u8 = 3;
pub const MILESTONE_DENOMINATOR: u64 = 4;
