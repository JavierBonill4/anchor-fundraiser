use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct WhitelistEntry {
    pub fundraiser: Pubkey,
    pub contributor: Pubkey,
    pub is_allowed: bool,
    pub bump: u8,
}
