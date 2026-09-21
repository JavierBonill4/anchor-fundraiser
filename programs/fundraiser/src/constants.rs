pub const ANCHOR_DISCRIMINATOR: usize = 8;
pub const MIN_AMOUNT_TO_RAISE: u64 = 3;
pub const SECONDS_TO_DAYS: i64 = 86400;
pub const MAX_CONTRIBUTION_PERCENTAGE: u64 = 10;
pub const PERCENTAGE_SCALER: u64 = 100;

/// Anchor 1.x re-exports the `SysvarId` traits but not the individual ids.
pub const SLOT_HASHES_ID: anchor_lang::prelude::Pubkey =
    anchor_lang::prelude::Pubkey::from_str_const("SysvarS1otHashes111111111111111111111111111");

/// `[len: u64][slot: u64][hash: 32]...`, newest first, so the newest hash is at 16..48.
pub const SLOT_HASH_OFFSET: usize = 16;
pub const SLOT_HASH_END: usize = SLOT_HASH_OFFSET + 32;