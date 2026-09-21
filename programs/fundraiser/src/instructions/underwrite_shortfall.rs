use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer, Mint, Token, TokenAccount, Transfer,
};

use crate::{
    state::{Fundraiser, FundraiserState, UnderwriterPosition},
    FundraiserError, ANCHOR_DISCRIMINATOR, BASE_PREMIUM_RATE, BPS, CURVE_SLOPE,
};

/// Permissionless instruction: anyone can underwrite the shortfall during the
/// underwriting phase. The bonding curve determines the premium.
///
/// Pricing formula (all in basis points):
///
///   utilization = total_underwritten / original_shortfall
///   premium_rate = BASE_PREMIUM_RATE + (utilization * CURVE_SLOPE / BPS)
///   claim_amount = principal * (BPS + premium_rate) / BPS
///
/// Example with BPS=10000, BASE=1000, SLOPE=500:
///   - 0% utilization: premium = 10%, claim = 1100 per 1000 deposited
///   - 50% utilization: premium = 12.5%, claim = 1125 per 1000 deposited
///   - 100% utilization: premium = 15%, claim = 1150 per 1000 deposited
///
/// Rounding: always rounds DOWN in favor of the protocol (underwriter gets
/// slightly less, never more). This prevents rounding-based free value.
#[derive(Accounts)]
pub struct UnderwriteShortfall<'info> {
    #[account(mut)]
    pub underwriter: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        init_if_needed,
        payer = underwriter,
        seeds = [b"underwriter", fundraiser.key().as_ref(), underwriter.key().as_ref()],
        bump,
        space = ANCHOR_DISCRIMINATOR + UnderwriterPosition::INIT_SPACE,
    )]
    pub underwriter_position: Account<'info, UnderwriterPosition>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = underwriter,
    )]
    pub underwriter_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = fundraiser.mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> UnderwriteShortfall<'info> {
    pub fn underwrite_shortfall(&mut self, amount: u64, bumps: &UnderwriteShortfallBumps) -> Result<()> {
        // ---- state checks ----

        // Must be in Underwriting phase
        require!(
            self.fundraiser.state == FundraiserState::Underwriting,
            FundraiserError::NotInUnderwritingPhase
        );

        // Underwriting deadline must not have passed
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            current_time < self.fundraiser.underwriting_deadline,
            FundraiserError::UnderwritingExpired
        );

        // ---- amount validation ----

        // Must be at least one whole token
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::Overflow)?;
        require!(amount >= one_token, FundraiserError::UnderwritingTooSmall);

        // Calculate remaining shortfall
        let remaining_shortfall = self
            .fundraiser
            .original_shortfall
            .checked_sub(self.fundraiser.total_underwritten)
            .ok_or(FundraiserError::Overflow)?;

        require!(remaining_shortfall > 0, FundraiserError::NoShortfall);

        // Cannot exceed remaining shortfall
        require!(
            amount <= remaining_shortfall,
            FundraiserError::ExceedsRemainingShortfall
        );

        // ---- bonding curve pricing ----

        // utilization = total_underwritten / original_shortfall (in bps)
        // We multiply by BPS first to keep precision: utilization_bps = total * BPS / original
        let utilization_bps = self
            .fundraiser
            .total_underwritten
            .checked_mul(BPS)
            .ok_or(FundraiserError::Overflow)?
            .checked_div(self.fundraiser.original_shortfall)
            .ok_or(FundraiserError::Overflow)?;

        // premium_rate = BASE_PREMIUM_RATE + (utilization_bps * CURVE_SLOPE / BPS)
        let premium_rate = BASE_PREMIUM_RATE
            .checked_add(
                utilization_bps
                    .checked_mul(CURVE_SLOPE)
                    .ok_or(FundraiserError::Overflow)?
                    .checked_div(BPS)
                    .ok_or(FundraiserError::Overflow)?,
            )
            .ok_or(FundraiserError::Overflow)?;

        // claim_amount = principal * (BPS + premium_rate) / BPS
        // Always rounds DOWN (floor division) to prevent free value
        let claim_amount = amount
            .checked_mul(
                BPS
                    .checked_add(premium_rate)
                    .ok_or(FundraiserError::Overflow)?,
            )
            .ok_or(FundraiserError::Overflow)?
            .checked_div(BPS)
            .ok_or(FundraiserError::Overflow)?;

        // ---- CPI: transfer tokens from underwriter to vault ----

        let cpi_accounts = Transfer {
            from: self.underwriter_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.underwriter.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(self.token_program.key(), cpi_accounts);
        transfer(cpi_ctx, amount)?;

        // ---- update state ----

        // Initialize or update the underwriter position
        // If this is a fresh position (init_if_needed created it), set all fields.
        // If it already exists, we add to it (multiple underwriting transactions).
        if self.underwriter_position.principal == 0 {
            // Fresh position
            self.underwriter_position.set_inner(UnderwriterPosition {
                fundraiser: self.fundraiser.key(),
                underwriter: self.underwriter.key(),
                principal: amount,
                claim_amount,
                created_at: current_time,
                claimed: false,
                bump: bumps.underwriter_position,
            });
        } else {
            // Existing position: accumulate principal and claim
            self.underwriter_position.principal = self
                .underwriter_position
                .principal
                .checked_add(amount)
                .ok_or(FundraiserError::Overflow)?;
            self.underwriter_position.claim_amount = self
                .underwriter_position
                .claim_amount
                .checked_add(claim_amount)
                .ok_or(FundraiserError::Overflow)?;
        }

        // Update fundraiser totals
        self.fundraiser.total_underwritten = self
            .fundraiser
            .total_underwritten
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;

        self.fundraiser.total_outstanding_claims = self
            .fundraiser
            .total_outstanding_claims
            .checked_add(claim_amount)
            .ok_or(FundraiserError::Overflow)?;

        // Check if shortfall is fully filled -> transition to Underwritten
        if self.fundraiser.total_underwritten >= self.fundraiser.original_shortfall {
            self.fundraiser.state = FundraiserState::Underwritten;
        }

        Ok(())
    }
}
