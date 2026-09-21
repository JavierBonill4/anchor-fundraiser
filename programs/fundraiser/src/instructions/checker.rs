use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{transfer, Mint, Token, TokenAccount, Transfer},
};

use crate::{
    state::Fundraiser, FundraiserError, SLOT_HASHES_ID, SLOT_HASH_END, SLOT_HASH_OFFSET,
};

#[derive(Accounts)]
pub struct CheckContributions<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser".as_ref(), maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = maker,
        associated_token::mint = mint_to_raise,
        associated_token::authority = maker,
    )]
    pub maker_ata: Account<'info, TokenAccount>,
    /// CHECK: pinned by address, read as raw bytes. The sysvar is ~20 KB, so
    /// deserializing it properly would cost more than the whole instruction.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> CheckContributions<'info> {
    pub fn check_contributions(&mut self) -> Result<()> {
        // Fires once. Checked before the target, because after the payout the vault
        // holds only the prize and would report TargetNotMet instead.
        require!(!self.fundraiser.drawn, FundraiserError::AlreadyDrawn);

        // The program's own tally, not the vault balance. The vault is an ordinary
        // token account anyone can send to, so a maker could top it up to fake a
        // successful raise and be paid the full target out of real contributions.
        require!(
            self.fundraiser.current_amount >= self.fundraiser.amount_to_raise,
            FundraiserError::TargetNotMet
        );

        require!(
            self.fundraiser.total_tickets > 0,
            FundraiserError::NoTicketsIssued
        );

        // The slot hash is the entropy: the only on-chain value still unknown while
        // contributions are open, which is what stops a backer computing the winning
        // number and buying a range around it. It is not unknown to whoever sends
        // this transaction — see the readme.
        //
        // Little endian, first eight bytes, stated because the tests reproduce it
        // off-chain. Modulo bias is ~total_tickets/2^64 and is ignored.
        let slot_hash = self.newest_slot_hash()?;
        let entropy = u64::from_le_bytes(
            slot_hash[..8]
                .try_into()
                .map_err(|_| error!(FundraiserError::SlotHashUnavailable))?,
        );

        self.fundraiser.winning_ticket = entropy % self.fundraiser.total_tickets;
        self.fundraiser.drawn = true;

        msg!(
            "Draw: ticket {} of {}",
            self.fundraiser.winning_ticket,
            self.fundraiser.total_tickets
        );

        // The maker is paid exactly what they asked to raise. The overshoot stays in
        // the vault as the prize — money the maker never had a claim on.
        let payout = self.fundraiser.amount_to_raise;

        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.maker_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        transfer(
            CpiContext::new_with_signer(
                self.token_program.key(),
                cpi_accounts,
                &signer_seeds,
            ),
            payout,
        )?;

        Ok(())
    }

    /// The hash of the most recently completed slot.
    fn newest_slot_hash(&self) -> Result<[u8; 32]> {
        let data = self.slot_hashes.try_borrow_data()?;
        require!(
            data.len() >= SLOT_HASH_END,
            FundraiserError::SlotHashUnavailable
        );

        let mut slot_hash = [0u8; 32];
        slot_hash.copy_from_slice(&data[SLOT_HASH_OFFSET..SLOT_HASH_END]);

        // All zeroes means the sysvar is empty, which would draw ticket zero every time.
        require!(
            slot_hash != [0u8; 32],
            FundraiserError::SlotHashUnavailable
        );

        Ok(slot_hash)
    }
}
