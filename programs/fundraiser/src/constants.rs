pub const ANCHOR_DISCRIMINATOR: usize = 8;
pub const MIN_AMOUNT_TO_RAISE: u64 = 3;
pub const SECONDS_TO_DAYS: i64 = 86400;
pub const MAX_CONTRIBUTION_PERCENTAGE: u64 = 10;
pub const PERCENTAGE_SCALER: u64 = 100;

/// Reward tokens minted per token contributed.
///
/// The reward mint is created with the same decimals as the mint being raised,
/// so this is a whole-token ratio with no rescaling and no integer division —
/// 1 USDC in, 10 CAMPAIGN out, exactly, at any contribution size.
pub const REWARD_RATE: u64 = 10;

/// Seed prefix for the per-campaign reward mint.
pub const REWARD_MINT_SEED: &[u8] = b"reward";
