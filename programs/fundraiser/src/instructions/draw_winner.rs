use anchor_lang::prelude::*;
use crate::{
    state::Fundraiser,
    error::FundraiserError,
};

pub const SLOT_HASHES_SYSVAR_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");

#[derive(Accounts)]
pub struct DrawWinner<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [b"fundraiser".as_ref(), fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    /// CHECK: Validated against Solana Sysvar SlotHashes ID
    #[account(address = SLOT_HASHES_SYSVAR_ID @ FundraiserError::SlotHashesUnavailable)]
    pub slot_hashes: UncheckedAccount<'info>,
}

impl<'info> DrawWinner<'info> {
    pub fn draw_winner(&mut self) -> Result<()> {
        // Enforce that the target has been reached
        require!(
            self.fundraiser.current_amount >= self.fundraiser.amount_to_raise,
            FundraiserError::TargetNotMet
        );

        // Enforce that tickets have been issued
        require!(
            self.fundraiser.total_tickets > 0,
            FundraiserError::NoTicketsIssued
        );

        // Enforce that a winner has not already been drawn
        require!(
            !self.fundraiser.winner_drawn,
            FundraiserError::WinnerAlreadyDrawn
        );

        // Read the most recent slot hash from the SlotHashes sysvar
        let data = self.slot_hashes.try_borrow_data()?;
        require!(data.len() >= 48, FundraiserError::SlotHashesUnavailable);

        // In Solana SlotHashes sysvar:
        // [0..8] = number of entries (u64)
        // [8..16] = slot of first entry (u64)
        // [16..48] = 32-byte hash of the most recent slot
        let mut hash_bytes = [0u8; 32];
        hash_bytes.copy_from_slice(&data[16..48]);

        // Derive pseudo-random 64-bit integer from the first 8 bytes of the hash
        let random_u64 = u64::from_le_bytes(hash_bytes[0..8].try_into().unwrap());
        let winning_ticket = random_u64 % self.fundraiser.total_tickets;

        self.fundraiser.winning_ticket = winning_ticket;
        self.fundraiser.winner_drawn = true;

        emit!(WinnerDrawn {
            fundraiser: self.fundraiser.key(),
            winning_ticket,
            total_tickets: self.fundraiser.total_tickets,
        });

        Ok(())
    }
}

#[event]
pub struct WinnerDrawn {
    pub fundraiser: Pubkey,
    pub winning_ticket: u64,
    pub total_tickets: u64,
}
