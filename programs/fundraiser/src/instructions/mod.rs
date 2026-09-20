/// Creates a new fundraiser and its token vault.
pub mod initialize;

/// Accepts contributions and records each contributor's total.
pub mod contribute;

/// Allows the maker to collect funds after reaching the target.
pub mod checker;

/// Returns tokens when a fundraiser ends without reaching its target.
pub mod refund;

/// Mints one non-transferable receipt NFT for a valid contributor.
pub mod mint_receipt;

// Re-export each account context so lib.rs can use the instruction
// types without writing their complete module paths.
pub use initialize::*;
pub use contribute::*;
pub use checker::*;
pub use refund::*;
pub use mint_receipt::*;