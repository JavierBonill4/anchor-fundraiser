use anchor_lang::prelude::*;

/// Represents an underwriter's position in a fundraiser's shortfall.
///
/// Each position tracks:
/// - The principal deposited
/// - The future claim amount (principal + premium from bonding curve)
/// - Whether the position has been claimed
///
/// PDA Seeds: ["underwriter", fundraiser.key(), underwriter.key()]
/// One position per underwriter per fundraiser (multiple positions possible
/// if underwriting in separate transactions).
#[account]
#[derive(InitSpace)]
pub struct UnderwriterPosition {
    /// The fundraiser this position is for
    pub fundraiser: Pubkey,
    /// The wallet that owns this position
    pub underwriter: Pubkey,
    /// Amount of tokens deposited by the underwriter
    pub principal: u64,
    /// Future claim amount (principal + premium), calculated at creation time
    pub claim_amount: u64,
    /// Unix timestamp when this position was created
    pub created_at: i64,
    /// Whether this position has been claimed (prevents double claims)
    pub claimed: bool,
    /// Bump seed for PDA derivation
    pub bump: u8,
}
