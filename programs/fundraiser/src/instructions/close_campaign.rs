use anchor_lang::prelude::*;
use anchor_spl::token::{
    close_account,
    CloseAccount,
    Mint,
    Token,
    TokenAccount
};

use crate::{
    state::Fundraiser,
    FundraiserError,
    SECONDS_TO_DAYS
};

/// Winds up a campaign that did not reach its target.
///
/// This is a crank: anyone may call it. The trigger is time plus a condition
/// nobody in particular owns — the maker has no reason to pay a fee to clean up
/// a campaign that failed, and the contributors have already taken their money
/// back. Making it permissionless means the account can always be reclaimed by
/// whoever cares, and the rent still goes to the maker who paid it.
///
/// The success path does not need one of these: `check_contributions` closes
/// both accounts itself, because the maker is already there signing.
#[derive(Accounts)]
pub struct CloseCampaign<'info> {
    /// Whoever is doing the housekeeping. Signs to pay the fee, gains nothing.
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
    pub token_program: Program<'info, Token>,
}

impl<'info> CloseCampaign<'info> {
    pub fn close_campaign(&self) -> Result<()> {

        // Nothing may be wound up while it could still succeed.
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                >= self.fundraiser.duration as i64,
            FundraiserError::FundraiserNotEnded
        );

        // The load-bearing check. `refund` is the only way a contributor gets
        // their money out, and it needs this fundraiser account to derive the
        // signer seeds. Close it with tokens still in the vault and those tokens
        // are unreachable forever — there would be no instruction left that can
        // sign for the vault's authority.
        require!(self.vault.amount == 0, FundraiserError::VaultNotEmpty);

        let id_bytes = self.fundraiser.id.to_le_bytes();
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            id_bytes.as_ref(),
            &[self.fundraiser.bump],
        ]];

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
