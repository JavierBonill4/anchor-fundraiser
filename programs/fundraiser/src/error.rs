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
    #[msg("The contribution cap must be between 1% and 10%")]
    InvalidContributionCap,
    #[msg("The contribution cap is locked after the first contribution")]
    ContributionCapLocked,
    #[msg("Only the fundraiser maker can update the contribution cap")]
    UnauthorizedMaker,
    #[msg("Token amount arithmetic overflowed")]
    ArithmeticOverflow,
    #[msg("Token amount arithmetic underflowed")]
    ArithmeticUnderflow,
}
