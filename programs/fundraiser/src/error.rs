use anchor_lang::error_code;

#[error_code]
pub enum FundraiserError {
    #[msg("The amount to raise has not been met")]
    TargetNotMet,
    #[msg("The amount to raise has been achieved")]
    TargetMet,
    #[msg("The contribution is too big")]
    ContributionTooBig,
    #[msg("The contribution is too small")]
    ContributionTooSmall,
    #[msg("The maximum amount to contribute has been reached")]
    MaximumContributionsReached,
    #[msg("The fundraiser has not ended yet")]
    FundraiserNotEnded,
    #[msg("The fundraiser has ended")]
    FundraiserEnded,
    #[msg("Invalid total amount. i should be bigger than 3")]
    InvalidAmount,
    // ---- new errors for underwriting ----
    #[msg("Fundraiser is not in the underwriting phase")]
    NotInUnderwritingPhase,
    #[msg("Underwriting phase has expired")]
    UnderwritingExpired,
    #[msg("Amount exceeds remaining shortfall")]
    ExceedsRemainingShortfall,
    #[msg("Underwriting amount too small (minimum 1 whole token)")]
    UnderwritingTooSmall,
    #[msg("This position has already been claimed")]
    AlreadyClaimed,
    #[msg("Insufficient repayment liquidity in vault")]
    InsufficientRepayment,
    #[msg("Not the position owner")]
    NotPositionOwner,
    #[msg("No shortfall to underwrite")]
    NoShortfall,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Fundraiser is not in the settled state")]
    NotSettled,
}