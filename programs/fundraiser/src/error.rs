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
    #[msg("Too many collaborations for this contributor")]
    TooManyCollaborations,
    #[msg("The campaign has already been claimed")]
    AlreadyClaimed,
    #[msg("The metadata URI is empty or too long")]
    InvalidUri,
    #[msg("The campaign has not been claimed yet")]
    CampaignNotClaimed,
    #[msg("This contributor already received a badge")]
    BadgeAlreadyMinted,
    #[msg("Not every contributor has received a badge")]
    BadgesOutstanding,
    #[msg("The vault still holds tokens")]
    VaultNotEmpty,
    #[msg("Only the designated minter can airdrop badges")]
    UnauthorizeMinter,
}
