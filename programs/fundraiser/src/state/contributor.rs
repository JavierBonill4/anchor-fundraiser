use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Collaboration {
    pub timestamp: i64,
    pub amount: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub fundraiser: Pubkey,
    pub contributor: Pubkey,
    pub amount: u64,
    pub position: u32,
    pub bump: u8,
    pub badge_minted: bool,
    #[max_len(16)]
    pub collaborations: Vec<Collaboration>,
}
