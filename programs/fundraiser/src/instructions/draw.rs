use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::{state::Fundraiser, FundraiserError, WinnerDrawn};

const SLOT_HASHES: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");

#[derive(Accounts)]
pub struct Draw<'info> {
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: SlotHashes sysvar
    #[account(address = SLOT_HASHES)]
    pub slot_hashes: UncheckedAccount<'info>,
}

impl<'info> Draw<'info> {
    pub fn draw(&mut self) -> Result<()> {
        require!(!self.fundraiser.drawn, FundraiserError::AlreadyDrawn);
        require!(
            self.fundraiser.total_tickets > 0,
            FundraiserError::NoTickets
        );
        require!(
            self.vault.amount >= self.fundraiser.amount_to_raise,
            FundraiserError::TargetNotMet
        );

        let data = self.slot_hashes.try_borrow_data()?;
        // u64 count, then (u64 slot, [u8; 32] hash) entries
        require!(data.len() >= 8 + 8 + 32, FundraiserError::InvalidSlotHashes);
        let num = u64::from_le_bytes(data[0..8].try_into().unwrap());
        require!(num >= 1, FundraiserError::InvalidSlotHashes);

        let hash = &data[16..48];
        let raw = u64::from_le_bytes(hash[0..8].try_into().unwrap());
        let winning = raw % self.fundraiser.total_tickets;

        self.fundraiser.winning_ticket = winning;
        self.fundraiser.drawn = true;

        emit!(WinnerDrawn {
            fundraiser: self.fundraiser.key(),
            winning_ticket: winning,
            total_tickets: self.fundraiser.total_tickets,
        });
        Ok(())
    }
}
