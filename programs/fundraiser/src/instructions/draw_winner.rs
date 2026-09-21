use anchor_lang::prelude::*;
//use anchor_lang::solana_program::sysvar::slot_hashes;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};
use sha2::{Digest, Sha256};
use std::str::FromStr;

use crate::{
    state::{Bond, Contributor, Fundraiser}, FundraiserError, SECONDS_TO_DAYS,
};

#[derive(Accounts)]
pub struct DrawWinner<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [b"bond", fundraiser.key().as_ref()],
        bump = bond.bump,
    )]
    pub bond: Account<'info, Bond>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub winner_wallet: SystemAccount<'info>,
    #[account(
        seeds = [b"contributor", fundraiser.key().as_ref(), winner_wallet.key().as_ref()],
        bump,
    )]
    pub winner_contributor: Account<'info, Contributor>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = winner_wallet,
    )]
    pub winner_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = maker,
    )]
    pub maker_ata: Account<'info, TokenAccount>,
    #[account(address = Pubkey::from_str("SysvarS1otHashes111111111111111111111111111").unwrap())]
    pub slot_hashes: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

impl<'info> DrawWinner<'info> {
    pub fn draw_winner(&mut self, secret: [u8; 32]) -> Result<()> {
        require!(!self.fundraiser.winner_drawn, FundraiserError::WinnerAlreadyDrawn);

        let now = Clock::get()?.unix_timestamp;
        let window_close = self.fundraiser.time_started
            .checked_add((self.fundraiser.duration as i64).checked_mul(SECONDS_TO_DAYS).ok_or(FundraiserError::Overflow)?)
            .ok_or(FundraiserError::Overflow)?;
        require!(now >= window_close, FundraiserError::WindowStillOpen);
        require!(now <= self.fundraiser.reveal_deadline, FundraiserError::WinnerAlreadyDrawn);
        require!(self.vault.amount >= self.fundraiser.amount_to_raise, FundraiserError::TargetNotMet);

        let computed: [u8; 32] = Sha256::digest(&secret).into();
        require!(computed == self.fundraiser.reveal_hash, FundraiserError::RevealHashMismatch);

        // derive the winning ticket from secret + a recent slot hash
        let sh_data = self.slot_hashes.try_borrow_data()?;
        require!(sh_data.len() >= 48, FundraiserError::Overflow);
        let mut seed = secret.to_vec();
        seed.extend_from_slice(&sh_data[16..48]);
        drop(sh_data);
        let digest: [u8; 32] = Sha256::digest(&seed).into();
        let rand_u64 = u64::from_le_bytes(digest[0..8].try_into().unwrap());
        let winning_ticket = rand_u64 % self.fundraiser.total_tickets;

        // prove the claimed winner actually holds that ticket
        msg!("winning_ticket={} total_tickets={} range=[{}, {})",
            winning_ticket, self.fundraiser.total_tickets,
            self.winner_contributor.ticket_start, self.winner_contributor.ticket_end);

        require!(
            winning_ticket >= self.winner_contributor.ticket_start
                && winning_ticket < self.winner_contributor.ticket_end,
            FundraiserError::NotTheWinner
        );

        let reward_amount = ((self.vault.amount as u128)
            .checked_mul(self.fundraiser.reward_bps as u128)
            .ok_or(FundraiserError::Overflow)?
            / 10_000u128) as u64;
        let maker_amount = self.vault.amount
            .checked_sub(reward_amount)
            .ok_or(FundraiserError::Overflow)?;

        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        transfer(
            CpiContext::new_with_signer(
                self.token_program.key(),
                Transfer { from: self.vault.to_account_info(), to: self.winner_ata.to_account_info(), authority: self.fundraiser.to_account_info() },
                &signer_seeds,
            ),
            reward_amount,
        )?;
        transfer(
            CpiContext::new_with_signer(
                self.token_program.key(),
                Transfer { from: self.vault.to_account_info(), to: self.maker_ata.to_account_info(), authority: self.fundraiser.to_account_info() },
                &signer_seeds,
            ),
            maker_amount,
        )?;

        // bond refunded instantly on a successful, verified reveal
        let bond_lamports = self.bond.to_account_info().lamports();
        **self.bond.to_account_info().try_borrow_mut_lamports()? -= bond_lamports;
        **self.maker.to_account_info().try_borrow_mut_lamports()? += bond_lamports;

        self.fundraiser.winner_drawn = true;
        Ok(())
    }
}