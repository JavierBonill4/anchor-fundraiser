use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer,
    Mint,
    Token,
    TokenAccount,
    Transfer
};

use crate::{
    state::{
        Contributor,
        Fundraiser
    },
    FundraiserError
};

/// Takes back the part of a bid the raise did not need.
///
/// A contribution is a *bid*, not a purchase. When the book shuts
/// oversubscribed, everyone is filled in proportion to what they put in, and
/// the unfilled remainder comes back here.
///
///     filled_i = ceil(amount_to_raise * bid_i / settled_total)
///     excess_i = bid_i - filled_i
///
/// The rounding direction is not cosmetic. With `filled` rounded *down*, the
/// fills sum to less than the target while the claims sum to more than the vault
/// holds, and the last person to claim finds the vault empty. Rounding up makes
/// the fills sum to at least the target, so claims can never exceed the
/// remainder; what is left over is dust, and `close_campaign` sweeps it.
#[derive(Accounts)]
pub struct ClaimExcess<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = maker,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", maker.key().as_ref(), &fundraiser.id.to_le_bytes()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [
            b"contributor",
            fundraiser.key().as_ref(),
            contributor.key().as_ref(),
            &fundraiser.time_started.to_le_bytes(),
        ],
        bump,
        close = contributor,
    )]
    pub contributor_account: Account<'info, Contributor>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = contributor
    )]
    pub contributor_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> ClaimExcess<'info> {
    pub fn claim_excess(&mut self) -> Result<()> {

        require!(self.fundraiser.settled, FundraiserError::NotSettled);

        let bid = self.contributor_account.amount;
        let target = self.fundraiser.amount_to_raise;
        let total = self.fundraiser.settled_total;

        // `settled_total >= amount_to_raise` was checked at settlement and
        // neither field moves afterwards, so this cannot be zero — but a
        // division that only *probably* has a non-zero denominator is not worth
        // the compute unit saved.
        require!(total > 0, FundraiserError::NotSettled);

        // u128 throughout: `target * bid` passes u64 at entirely ordinary sizes.
        // A 1,000,000 token target with a 1,000,000 token bid, both at 6
        // decimals, is 1e24 — twenty thousand times u64::MAX.
        let numerator = (target as u128)
            .checked_mul(bid as u128)
            .ok_or(FundraiserError::Overflow)?;
        let filled_u128 = numerator
            .checked_add(total as u128 - 1)
            .ok_or(FundraiserError::Overflow)?
            / (total as u128);
        let filled = u64::try_from(filled_u128).map_err(|_| FundraiserError::Overflow)?;

        let excess = bid.checked_sub(filled).ok_or(FundraiserError::Overflow)?;

        // Leaving the book, filled or not. `close_campaign` waits for zero.
        self.fundraiser.current_amount = self
            .fundraiser
            .current_amount
            .checked_sub(bid)
            .ok_or(FundraiserError::Overflow)?;

        // A fully filled bid claims nothing, and still has to come through here
        // to clear itself off the book and reclaim its own rent.
        if excess > 0 {
            let id_bytes = self.fundraiser.id.to_le_bytes();
            let signer_seeds: [&[&[u8]]; 1] = [&[
                b"fundraiser".as_ref(),
                self.maker.to_account_info().key.as_ref(),
                id_bytes.as_ref(),
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
                excess,
            )?;
        }

        Ok(())
    }
}
