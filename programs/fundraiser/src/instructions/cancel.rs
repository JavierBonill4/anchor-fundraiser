use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::{state::Fundraiser, FundraiserError};

/// Cancelling a campaign.
///
/// A fundraiser that is clearly not going to make its target leaves everyone's
/// money locked until the duration runs out — up to 255 days, for a campaign
/// whose maker already knows it has failed. `cancel_fundraiser` lets the maker
/// close it early: contributions stop, and `refund` opens immediately instead
/// of waiting for the deadline.
///
/// The maker is checked in the handler rather than with `has_one`, and the PDA
/// is derived from `fundraiser.maker` rather than from the signer. Deriving it
/// from the signer would make a stranger's attempt fail as ConstraintSeeds —
/// "this account is not the one you asked for" — which says nothing about what
/// actually went wrong. This way an outsider gets UnauthorizedMaker.
#[derive(Accounts)]
pub struct CancelFundraiser<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser".as_ref(), fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
}

impl<'info> CancelFundraiser<'info> {
    pub fn cancel_fundraiser(&mut self) -> Result<()> {
        // Only the maker may cancel their own campaign.
        require_keys_eq!(
            self.authority.key(),
            self.fundraiser.maker,
            FundraiserError::UnauthorizedMaker
        );

        // Cancelling twice is a no-op that would still emit a success, which
        // makes "was this campaign stopped by me or by someone else" harder to
        // read off-chain than it needs to be.
        require!(
            !self.fundraiser.cancelled,
            FundraiserError::AlreadyCancelled
        );

        // A campaign that already hit its target is not the maker's to unwind.
        // The money belongs to the contributors' intent at that point, and
        // `check_contributions` is the instruction that settles it.
        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            FundraiserError::TargetMet
        );

        self.fundraiser.cancelled = true;

        Ok(())
    }
}
