use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer, Mint, Token, TokenAccount, Transfer,
};

use crate::{
    state::{Fundraiser, FundraiserState, UnderwriterPosition},
    FundraiserError,
};

/// The underwriter claims their repayment after the maker has settled.
///
/// Requirements:
///   - Fundraiser must be in Settled state (maker has repaid)
///   - Position must not have been claimed already (prevents double claim)
///   - Caller must be the position owner
///   - Vault must have sufficient liquidity for the claim
///
/// After claiming, the position is closed and rent is returned to the underwriter.
#[derive(Accounts)]
pub struct ClaimUnderwriting<'info> {
    #[account(mut)]
    pub underwriter: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        seeds = [b"fundraiser", fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [b"underwriter", fundraiser.key().as_ref(), underwriter.key().as_ref()],
        bump = underwriter_position.bump,
        has_one = underwriter,
        close = underwriter,
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
}

impl<'info> ClaimUnderwriting<'info> {
    pub fn claim_underwriting(&mut self) -> Result<()> {
        // Must be settled (maker has repaid all claims)
        require!(
            self.fundraiser.state == FundraiserState::Settled,
            FundraiserError::NotSettled
        );

        // Must not have been claimed already
        require!(
            !self.underwriter_position.claimed,
            FundraiserError::AlreadyClaimed
        );

        // Vault must have enough tokens for this claim
        require!(
            self.vault.amount >= self.underwriter_position.claim_amount,
            FundraiserError::InsufficientRepayment
        );

        let claim_amount = self.underwriter_position.claim_amount;

        // CPI: transfer claim from vault to underwriter ATA
        // Signed by the fundraiser PDA
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.fundraiser.maker.as_ref(),
            &[self.fundraiser.bump],
        ]];

        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.underwriter_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let cpi_ctx =
            CpiContext::new_with_signer(self.token_program.key(), cpi_accounts, &signer_seeds);
        transfer(cpi_ctx, claim_amount)?;

        // Mark as claimed (prevents double claim)
        // The account will be closed by the `close = underwriter` constraint
        // after this instruction returns, returning rent to the underwriter.
        self.underwriter_position.claimed = true;

        Ok(())
    }
}
