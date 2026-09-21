pub const ANCHOR_DISCRIMINATOR: usize = 8;
pub const MIN_AMOUNT_TO_RAISE: u64 = 3;
pub const SECONDS_TO_DAYS: i64 = 86400;
pub const MAX_CONTRIBUTION_PERCENTAGE: u64 = 10;
pub const PERCENTAGE_SCALER: u64 = 100;

// ---- Underwriting / Bonding Curve Constants ----

/// Basis points scale (100% = 10_000 bps). Used for premium calculations.
pub const BPS: u64 = 10_000;

/// Base premium rate in basis points (10% = 1_000 bps).
/// Every underwriter gets at least this rate.
pub const BASE_PREMIUM_RATE: u64 = 1_000;

/// Additional premium slope in basis points (5% = 500 bps).
/// Scales linearly with utilization (0% to 100%).
/// At full utilization, premium = BASE_PREMIUM_RATE + CURVE_SLOPE = 1_500 bps (15%).
pub const CURVE_SLOPE: u64 = 500;

/// Underwriting phase duration in days.
/// After the fundraiser deadline, underwriters have this many days to fill the shortfall.
pub const UNDERWRITING_DURATION_DAYS: i64 = 7;