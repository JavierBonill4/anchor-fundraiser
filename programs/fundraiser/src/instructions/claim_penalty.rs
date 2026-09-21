use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};

use crate::{
    state::{Bond, Contributor, Fundraiser}, FundraiserError, PENALTY_CLAIM_DELAY_SECS,
};

#[derive(Accounts)]
pub struct ClaimPenalty<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub maker: SystemAccount<'info>,
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
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        close = contributor,
    )]
    pub contributor_account: Account<'info, Contributor>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = contributor,
    )]
    pub contributor_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

impl<'info> ClaimPenalty<'info> {
    pub fn claim_penalty(&mut self) -> Result<()> {
        require!(!self.fundraiser.winner_drawn, FundraiserError::WinnerAlreadyDrawn);

        let now = Clock::get()?.unix_timestamp;
        let penalty_unlock = self
            .fundraiser
            .reveal_deadline
            .checked_add(PENALTY_CLAIM_DELAY_SECS)
            .ok_or(FundraiserError::Overflow)?;
        require!(now >= penalty_unlock, FundraiserError::DeadlineNotPassed);

       
        let claim = self.contributor_account.amount;
        let pool = self.fundraiser.current_amount;

        let bond_info = self.bond.to_account_info();
        let bond_lamports = bond_info.lamports();
        let rent_floor = Rent::get()?.minimum_balance(bond_info.data_len());

        let share: u64 = if pool == 0 || claim >= pool {
            bond_lamports // last claimant sweeps everything
        } else {
            let raw = ((bond_lamports as u128)
                .checked_mul(claim as u128)
                .ok_or(FundraiserError::Overflow)?
                / (pool as u128)) as u64;
            raw.min(bond_lamports.saturating_sub(rent_floor))
        };

        // Refund the contributor's original contribution.
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];
        transfer(
            CpiContext::new_with_signer(
                self.token_program.key(),
                Transfer {
                    from: self.vault.to_account_info(),
                    to: self.contributor_ata.to_account_info(),
                    authority: self.fundraiser.to_account_info(),
                },
                &signer_seeds,
            ),
            claim,
        )?;
        self.fundraiser.current_amount = pool.saturating_sub(claim);

        // Pay out the bond share.
        **bond_info.try_borrow_mut_lamports()? -= share;
        **self.contributor.to_account_info().try_borrow_mut_lamports()? += share;

        Ok(())
    }
}