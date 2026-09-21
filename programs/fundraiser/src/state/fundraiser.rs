use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Fundraiser {
    pub maker: Pubkey,
    pub mint_to_raise: Pubkey,
    pub amount_to_raise: u64,
    pub current_amount: u64,
    pub time_started: i64,
    pub duration: u8,
    pub bump: u8,
    /// Tickets issued so far, and the cursor the next range starts at.
    pub total_tickets: u64,
    /// Only meaningful once `drawn` is true.
    pub winning_ticket: u64,
    /// Set by `check_contributions`, in the same instruction that pays the maker.
    /// From that point the draw cannot fire again and no contribution or refund is
    /// accepted; the only thing left is the winner collecting the prize, which is
    /// still sitting in the vault.
    pub drawn: bool,
}
