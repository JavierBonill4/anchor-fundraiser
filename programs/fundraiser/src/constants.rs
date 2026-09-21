pub const ANCHOR_DISCRIMINATOR: usize = 8;
pub const MIN_AMOUNT_TO_RAISE: u64 = 3;
pub const SECONDS_TO_DAYS: i64 = 86400;
pub const MAX_CONTRIBUTION_PERCENTAGE: u64 = 10;
pub const PERCENTAGE_SCALER: u64 = 100;
/// Quarter milestones at 25%, 50% and 75% of the target. Bit `i` in
/// `milestones_fired` corresponds to `MILESTONE_NUMERATORS[i] / 4`.
pub const MILESTONE_NUMERATORS: [u64; 3] = [1, 2, 3];
pub const MILESTONE_DENOMINATOR: u64 = 4;