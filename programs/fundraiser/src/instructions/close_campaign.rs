use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{
        close_account,
        transfer,
        CloseAccount,
        Mint,
        Token,
        TokenAccount,
        Transfer
    }
};

use crate::{
    state::Fundraiser,
    FundraiserError,
    SECONDS_TO_DAYS
};

/// Winds up a campaign once nobody is owed anything.
///
/// This is a crank: anyone may call it. The trigger is a condition nobody in
/// particular owns — the maker has no reason to pay a fee to tidy up a campaign
/// that failed, and the contributors have already been paid out. Making it
/// permissionless means the accounts can always be reclaimed by whoever cares,
/// and the rent still goes to the maker who paid it.
///
/// It serves both endings, because both now leave a tail:
///   - missed the target -> every contributor `refund`s
///   - oversubscribed    -> the maker takes the target, every contributor
///                          `claim_excess`es the rest
/// Either way the book (`current_amount`) empties one contributor at a time, and
/// this is what fires when the last one leaves.
#[derive(Accounts)]
pub struct CloseCampaign<'info> {
    /// Whoever is doing the housekeeping. Signs to pay the fee, gains nothing.
    #[account(mut)]
    pub caller: Signer<'info>,
    /// Rent destination. Not a signer — the maker does not have to participate.
    #[account(mut)]
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = maker,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", maker.key().as_ref(), &fundraiser.id.to_le_bytes()],
        bump = fundraiser.bump,
        close = maker,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    /// Where the swept dust lands. `init_if_needed` because a maker whose
    /// campaign failed may never have been paid and may have no account yet.
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = mint_to_raise,
        associated_token::authority = maker,
    )]
    pub maker_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> CloseCampaign<'info> {
    pub fn close_campaign(&mut self) -> Result<()> {

        // Nothing may be wound up while it could still succeed.
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                >= self.fundraiser.duration as i64,
            FundraiserError::FundraiserNotEnded
        );

        // The load-bearing check, and note what it reads.
        //
        // `refund` and `claim_excess` are the only ways a contributor gets paid,
        // and both need this fundraiser account to derive the signer seeds. Close
        // it while anyone is still owed and their tokens are unreachable forever:
        // no instruction would be left that can sign for the vault's authority.
        //
        // It counts the book, not the vault. A vault balance of zero would be
        // both too weak and too strong — too weak because a settled campaign
        // still holds unclaimed excess, and too strong because anyone can
        // transfer a single token into an ATA and stall the wind-up on a whim.
        require!(
            self.fundraiser.current_amount == 0,
            FundraiserError::ClaimsOutstanding
        );

        let id_bytes = self.fundraiser.id.to_le_bytes();
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            id_bytes.as_ref(),
            &[self.fundraiser.bump],
        ]];

        // Whatever is left is truncation dust from the fills, plus anything a
        // stranger transferred in. `CloseAccount` refuses a non-empty account, so
        // it has to be swept first; it goes to the maker, who paid the rent.
        if self.vault.amount > 0 {
            transfer(
                CpiContext::new_with_signer(
                    self.token_program.key(),
                    Transfer {
                        from: self.vault.to_account_info(),
                        to: self.maker_ata.to_account_info(),
                        authority: self.fundraiser.to_account_info(),
                    },
                    &signer_seeds,
                ),
                self.vault.amount,
            )?;
        }

        close_account(CpiContext::new_with_signer(
            self.token_program.key(),
            CloseAccount {
                account: self.vault.to_account_info(),
                destination: self.maker.to_account_info(),
                authority: self.fundraiser.to_account_info(),
            },
            &signer_seeds,
        ))?;

        // The Fundraiser itself is closed by `close = maker` on the way out.
        Ok(())
    }
}
