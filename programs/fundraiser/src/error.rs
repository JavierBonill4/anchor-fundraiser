use anchor_lang::prelude::*;

/// Named errors returned by the fundraiser program.
///
/// Named errors make failures understandable to wallets, tests,
/// and users instead of returning an unclear generic failure.
#[error_code]
pub enum FundraiserError {
    /// The fundraiser cannot be completed because it did not
    /// collect the amount requested by the maker.
    #[msg("The fundraising target has not been met")]
    TargetNotMet,

    /// Refunds are unavailable because the fundraiser successfully
    /// collected its requested amount.
    #[msg("The fundraising target has been met")]
    TargetMet,

    /// One contribution is larger than the fundraiser permits.
    #[msg("The contribution is too big")]
    ContributionTooBig,

    /// Contributions must contain at least one whole token.
    #[msg("The contribution is too small")]
    ContributionTooSmall,

    /// This wallet has already contributed the maximum amount
    /// allowed for one contributor.
    #[msg("The maximum contribution amount has been reached")]
    MaximumContributionsReached,

    /// A refund cannot occur while the contribution window is open.
    #[msg("The fundraiser has not ended yet")]
    FundraiserNotEnded,

    /// New contributions cannot be accepted after the deadline.
    #[msg("The fundraiser has ended")]
    FundraiserEnded,

    /// The fundraising target must satisfy the program's minimum.
    #[msg("The fundraising target must be greater than the minimum amount")]
    InvalidAmount,

    /// A checked addition, multiplication, subtraction, division,
    /// or power operation could not be completed safely.
    #[msg("The calculation would overflow or underflow")]
    ArithmeticOverflow,

    /// A wallet must contribute successfully before it can receive
    /// a backer receipt NFT.
    #[msg("A contribution is required before minting a receipt")]
    NoContribution,

    /// Each contributor can receive only one receipt NFT for
    /// a particular fundraiser.
    #[msg("The contributor has already minted a receipt NFT")]
    ReceiptAlreadyMinted,

    /// The receipt mint must have zero decimal places because
    /// exactly one indivisible receipt token represents the NFT.
    #[msg("The receipt mint must have zero decimals")]
    InvalidReceiptMint,
}