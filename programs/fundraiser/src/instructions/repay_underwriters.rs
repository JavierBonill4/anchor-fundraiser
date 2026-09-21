use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer, Mint, Token, TokenAccount, Transfer,
};

use crate::{
    state::{Fundraiser, FundraiserState},
    FundraiserError,
};

/// The maker repays all outstanding underwriter claims by depositing the
/// required amount into the vault. After repayment:
///   - state transitions to Settled
///   - underwriters can call claim_underwriting to withdraw their share
///   - any surplus in the vault (original contributions + repayment - claims)
///     belongs to the maker and can be withdrawn separately
///
/// The maker MUST deposit at least total_outstanding_claims tokens.
/// They may deposit more (creating surplus), but the on-chain check only
/// enforces the minimum.
#[derive(Accounts)]
pub struct RepayUnderwriters<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        seeds = [b"fundraiser", fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = maker,
    )]
    pub maker_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = fundraiser.mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

impl<'info> RepayUnderwriters<'info> {
    pub fn repay_underwriters(&mut self, amount: u64) -> Result<()> {
        // Must be in Underwritten state (shortfall fully filled, awaiting repayment)
        require!(
            self.fundraiser.state == FundraiserState::Underwritten,
            FundraiserError::NotSettled
        );

        // Must have outstanding claims
        require!(
            self.fundraiser.total_outstanding_claims > 0,
            FundraiserError::InsufficientRepayment
        );

        // Maker must deposit at least enough to cover all claims
        require!(
            amount >= self.fundraiser.total_outstanding_claims,
            FundraiserError::InsufficientRepayment
        );

        // CPI: transfer tokens from maker ATA to vault
        let cpi_accounts = Transfer {
            from: self.maker_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.maker.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(self.token_program.key(), cpi_accounts);
        transfer(cpi_ctx, amount)?;

        // Transition to Settled
        self.fundraiser.state = FundraiserState::Settled;

        Ok(())
    }
}
