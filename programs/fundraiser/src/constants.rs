pub const ANCHOR_DISCRIMINATOR: usize = 8;
pub const MIN_AMOUNT_TO_RAISE: u64 = 3;
pub const SECONDS_TO_DAYS: i64 = 86400;
pub const MAX_CONTRIBUTION_PERCENTAGE: u64 = 10;
pub const PERCENTAGE_SCALER: u64 = 100;

/// Milestone thresholds as percentages of the target, low bit first.
/// Indexes into the `milestones_reached` bitmask on `Fundraiser`.
pub const MILESTONE_PERCENTAGES: [u64; 3] = [25, 50, 75];
