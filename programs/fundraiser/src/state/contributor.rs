use anchor_lang::prelude::*;

/// Stores one contributor's fundraising information.
///
/// This account is a PDA belonging to:
/// - one fundraiser
/// - one contributor wallet
///
/// The program uses it to track the contributor's deposited amount
/// and whether their one-time receipt NFT has already been minted.
#[account]
#[derive(InitSpace)]
pub struct Contributor {
    /// Total number of fundraising tokens contributed by this wallet.
    ///
    /// The program updates this value using checked arithmetic so an
    /// overflow cannot wrap the number back to a smaller value.
    pub amount: u64,

    /// Prevents the contributor from minting more than one receipt NFT.
    ///
    /// false = the receipt has not been minted yet
    /// true  = the contributor has already received their receipt
    pub receipt_minted: bool,
}