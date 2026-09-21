use anchor_lang::prelude::*;

/// Fundraiser state machine states.
/// 
/// State transitions:
///   ACTIVE -> SUCCESS (target met, maker claims)
///   ACTIVE -> UNDERWRITING (deadline passed, target missed)
///   UNDERWRITING -> UNDERWRITTEN (shortfall fully filled)
///   UNDERWRITING -> FAILED (underwriting deadline passed, not fully filled)
///   UNDERWRITTEN -> SETTLED (maker repaid all underwriters)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum FundraiserState {
    /// Fundraiser is accepting contributions
    Active,
    /// Target met, maker can claim funds
    Success,
    /// Deadline passed, target missed, underwriting phase open
    Underwriting,
    /// Shortfall fully filled by underwriters
    Underwritten,
    /// Maker has repaid all underwriters
    Settled,
    /// Underwriting phase expired without full underwriting, contributors can refund
    Failed,
}

#[account]
#[derive(InitSpace)]
pub struct Fundraiser {
    pub maker: Pubkey,
    pub mint_to_raise: Pubkey,
    pub amount_to_raise: u64,
    pub current_amount: u64,
    pub time_started: i64,
    pub duration: u8,
    pub bump: u8,
    // ---- new fields below (appended at end for Borsh compatibility) ----
    /// Current state in the fundraiser lifecycle
    pub state: FundraiserState,
    /// Shortfall amount (target - current_amount) when underwriting begins
    pub original_shortfall: u64,
    /// Total amount deposited by underwriters
    pub total_underwritten: u64,
    /// Total claim amounts owed to underwriters (principal + premium)
    pub total_outstanding_claims: u64,
    /// Deadline for the underwriting phase (unix timestamp)
    pub underwriting_deadline: i64,
}