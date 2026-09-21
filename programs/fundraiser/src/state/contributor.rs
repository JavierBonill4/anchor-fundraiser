use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64,
    /// Appended, not inserted: Borsh lays fields out in declaration order, so a
    /// field in the middle would shift every byte after it and silently
    /// misread accounts created before the change.
    pub rewards_claimed: bool,
}