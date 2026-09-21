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
    #[msg("Ticket sale has not reached the reveal deadline")]
    RevealNotDue,
    #[msg("The committed secret does not match the revealed value")]
    RevealHashMismatch,
    #[msg("The winner has already been drawn")]
    WinnerAlreadyDrawn,
    #[msg("The reveal deadline has not yet passed")]
    DeadlineNotPassed,
    #[msg("The penalty claim window has not opened yet")]
    PenaltyClaimNotYetOpen,
    #[msg("Draw attempted before the contribution window closed")]
    WindowStillOpen,
    #[msg("Overflow in ticket or reward arithmetic")]
    Overflow,
    #[msg("The winning ticket does not belong to this contributor")]
    NotTheWinner,
}