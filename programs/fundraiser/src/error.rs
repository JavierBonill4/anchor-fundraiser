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
    #[msg("Winner has already been drawn")]
    WinnerAlreadyDrawn,
    #[msg("Winner has not been drawn yet")]
    WinnerNotDrawn,
    #[msg("No tickets have been issued")]
    NoTicketsIssued,
    #[msg("The provided contributor account does not hold the winning ticket")]
    NotWinningTicket,
    #[msg("The raffle prize has already been claimed")]
    PrizeAlreadyClaimed,
    #[msg("SlotHashes sysvar is empty or unavailable")]
    SlotHashesUnavailable,
    #[msg("Cannot extend ticket range because another contributor has participated")]
    NonContiguousContribution,
    #[msg("The raffle prize must be claimed before maker can close the fundraiser")]
    PrizeNotClaimed,
}