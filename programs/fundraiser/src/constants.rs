pub const ANCHOR_DISCRIMINATOR: usize = 8;
pub const MIN_AMOUNT_TO_RAISE: u64 = 3;
pub const SECONDS_TO_DAYS: i64 = 86400;
pub const MAX_CONTRIBUTION_PERCENTAGE: u64 = 10;
pub const PERCENTAGE_SCALER: u64 = 100;

// `current_amount * 2 < amount_to_raise` marks an early contribution.
pub const EARLY_INVESTOR_THRESHOLD_DENOMINATOR: u64 = 2;

pub const EARLY_INVESTOR_NFT_NAME: &str = "Early Investor";
pub const EARLY_INVESTOR_NFT_SYMBOL: &str = "EARLY";
pub const EARLY_INVESTOR_NFT_URI: &str = "https://arweave.net/early-investor-placeholder";
