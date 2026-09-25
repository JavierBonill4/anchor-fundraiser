use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::{state::Fundraiser, FundraiserError};

/// Lets the maker call off their own campaign before the deadline.
///
/// Without this, contributors' funds are locked for the whole duration with no
/// escape hatch: `refund` only opens once `duration` days have elapsed *and* the
/// target was missed. If a maker abandons the campaign on day one, or it turns
/// out to be something contributors no longer want to fund, everyone waits out
/// the clock regardless. Cancelling flips that switch early — it opens refunds
/// immediately and permanently closes contributions.
///
/// Note what this deliberately does NOT do: it does not move any tokens. The
/// maker never touches the vault. Each contributor still calls `refund` for
/// themselves and is paid exactly what they put in, so cancelling is not a way
/// for the maker to reach other people's money.
#[derive(Accounts)]
pub struct Cancel<'info> {
    /// Must be the maker recorded on the fundraiser, and must sign.
    #[account(mut)]
    pub maker: Signer<'info>,

    pub mint_to_raise: Account<'info, Mint>,

    #[account(
        mut,
        has_one = mint_to_raise,
        // `has_one = maker` would also bind this, but the explicit check in the
        // handler returns a named error instead of Anchor's generic constraint
        // violation, which is what the abuse-case test asserts on.
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,

    #[account(
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
}

impl<'info> Cancel<'info> {
    pub fn cancel(&mut self) -> Result<()> {
        // Only the maker recorded at creation may cancel.
        //
        // The PDA seeds already tie `fundraiser` to whoever signed, so a stranger
        // passing their own key derives a different (non-existent) address. This
        // check is what turns that into a clear UnauthorizedMaker rather than an
        // account-not-initialized error, and it keeps holding if the seeds ever
        // change.
        require_keys_eq!(
            self.fundraiser.maker,
            self.maker.key(),
            FundraiserError::UnauthorizedMaker
        );

        // Cancelling twice is a no-op at best and a confusing event log at worst.
        require!(
            !self.fundraiser.cancelled,
            FundraiserError::AlreadyCancelled
        );

        // A campaign that already hit its target is the maker's to claim, not to
        // cancel. Allowing it would let a maker who dislikes the outcome strand
        // funds that contributors successfully raised.
        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            FundraiserError::TargetMet
        );

        self.fundraiser.cancelled = true;

        Ok(())
    }
}
