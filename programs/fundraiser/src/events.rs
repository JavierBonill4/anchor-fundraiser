use anchor_lang::prelude::*;

#[event]
pub struct CampaignClaimed {
    pub fundraiser: Pubkey,
    pub maker: Pubkey,
    pub contributor_count: u32,
}

#[event]
pub struct BadgeAirdropped {
    pub fundraiser: Pubkey,
    pub contributor: Pubkey,
    pub badge_mint: Pubkey,
    pub uri: String,
}

#[event]
pub struct ContributionRecorded {
    pub fundraiser: Pubkey,
    pub contributor: Pubkey,
    pub amount: u64,
    pub position: u32,
}
