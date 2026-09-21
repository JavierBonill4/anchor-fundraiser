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
    // ---- feat/contribution-receipts ----
    #[msg("This contributor has already claimed their receipt")]
    ReceiptAlreadyClaimed,
    #[msg("No contribution record exists for this contributor — nothing to receipt")]
    ContributorMissing,
    #[msg("This contributor never contributed a whole token, so no receipt is due")]
    NothingToReceipt,
    #[msg("The receipt counter overflowed — this cannot happen while u64 exists")]
    ReceiptOverflow,
    #[msg("Nothing to refund — this contributor never put in a whole token")]
    NothingToRefund
}