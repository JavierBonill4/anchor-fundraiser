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
    #[msg("The winner has already been drawn")]
    AlreadyDrawn,
    #[msg("The winner has not been drawn yet")]
    NotDrawn,
    #[msg("No tickets were issued, so there is nothing to draw from")]
    NoTicketsIssued,
    #[msg("This contributor does not hold the winning ticket")]
    NotWinningTicket,
    #[msg("The SlotHashes sysvar could not be read")]
    SlotHashUnavailable,
    #[msg("Ticket ranges must stay contiguous. Someone else entered after your last contribution")]
    NonContiguousTickets,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
