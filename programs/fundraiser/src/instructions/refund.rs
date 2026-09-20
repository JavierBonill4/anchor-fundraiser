use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer,
    Mint,
    Token,
    TokenAccount,
    Transfer,
};

use crate::{
    state::{
        Contributor,
        Fundraiser,
    },
    FundraiserError,
    SECONDS_TO_DAYS,
};

/// Accounts required to refund one contributor.
///
/// A refund is only permitted when:
/// 1. The fundraising period has ended.
/// 2. The fundraiser failed to reach its target.
/// 3. The contributor has a valid Contributor PDA.
///
/// After the refund succeeds, the Contributor PDA is closed. This also
/// prevents a refunded receipt NFT from qualifying for future rewards.
#[derive(Accounts)]
pub struct Refund<'info> {
    /// The contributor requesting their deposited tokens back.
    #[account(mut)]
    pub contributor: Signer<'info>,

    /// The wallet that originally created the fundraiser.
    pub maker: SystemAccount<'info>,

    /// The token mint used for fundraiser contributions.
    pub mint_to_raise: Account<'info, Mint>,

    /// The fundraiser state account.
    ///
    /// The PDA seeds prove that this fundraiser belongs to `maker`.
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [
            b"fundraiser",
            maker.key().as_ref(),
        ],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,

    /// Stores this contributor's deposited amount.
    ///
    /// `close = contributor` closes this PDA after a successful refund
    /// and returns its rent deposit to the contributor.
    ///
    /// Closing this account also invalidates the contributor's receipt
    /// NFT for future reward claims. The frozen receipt can remain in
    /// their wallet as a souvenir, but it is not sufficient by itself
    /// to qualify for future token drops.
    #[account(
        mut,
        seeds = [
            b"contributor",
            fundraiser.key().as_ref(),
            contributor.key().as_ref(),
        ],
        bump,
        close = contributor,
    )]
    pub contributor_account: Account<'info, Contributor>,

    /// The contributor's token account that receives the refund.
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = contributor,
    )]
    pub contributor_ata: Account<'info, TokenAccount>,

    /// The fundraiser vault holding all contributed tokens.
    ///
    /// The fundraiser PDA controls this account and signs the refund
    /// transfer using PDA signer seeds.
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The SPL Token program performs the refund transfer.
    pub token_program: Program<'info, Token>,

    /// Required by Anchor when the Contributor PDA is closed.
    pub system_program: Program<'info, System>,
}

impl<'info> Refund<'info> {
    /// Returns this contributor's deposited tokens after a failed fundraiser.
    pub fn refund(&mut self) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;

        // Calculate elapsed time safely.
        //
        // checked_sub prevents timestamp arithmetic from overflowing or
        // silently wrapping if the stored start time is invalid.
        let elapsed_seconds = current_time
            .checked_sub(self.fundraiser.time_started)
            .ok_or(FundraiserError::ArithmeticOverflow)?;

        let elapsed_days = elapsed_seconds
            .checked_div(SECONDS_TO_DAYS)
            .ok_or(FundraiserError::ArithmeticOverflow)?;

        // Refunds are locked until the fundraiser's deadline has passed.
        require!(
            elapsed_days >= self.fundraiser.duration as i64,
            FundraiserError::FundraiserNotEnded
        );

        // Refunds are only available when the campaign missed its target.
        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            FundraiserError::TargetMet
        );

        // Save the refund amount before performing the token transfer.
        let refund_amount = self.contributor_account.amount;

        // Calculate the new fundraiser total safely before the CPI.
        //
        // If the stored numbers are inconsistent, checked_sub returns an
        // error instead of wrapping around to a very large value.
        let updated_fundraiser_amount = self
            .fundraiser
            .current_amount
            .checked_sub(refund_amount)
            .ok_or(FundraiserError::ArithmeticOverflow)?;

        // The fundraiser PDA owns the vault, so it must sign the refund.
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"fundraiser",
            self.maker.key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        let transfer_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.contributor_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let transfer_context = CpiContext::new_with_signer(
            self.token_program.key(),
            transfer_accounts,
            signer_seeds,
        );

        // Return exactly the amount recorded for this contributor.
        transfer(transfer_context, refund_amount)?;

        // Update program state only after the token transfer succeeds.
        self.fundraiser.current_amount = updated_fundraiser_amount;

        // Anchor closes contributor_account automatically after this
        // handler succeeds because of `close = contributor`.
        Ok(())
    }
}