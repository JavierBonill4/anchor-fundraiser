use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]

pub struct Bond {
    pub fundraiser: Pubkey,
    pub bump: u8,
}