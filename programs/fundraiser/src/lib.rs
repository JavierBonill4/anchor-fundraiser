use anchor_lang::prelude::*;

declare_id!("7WferfAMCt6f32DYucuQNhnSYdoV7SWSR92od8t1jDzW");

mod state;
mod instructions;
mod error;
mod constants;

use instructions::*;
use error::*;
pub use constants::*;

#[program]
pub mod fundraiser {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, amount: u64, duration: u8) -> Result<()> {

        ctx.accounts.initialize(amount, duration, &ctx.bumps)?;

        Ok(())
    }

    pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {

        ctx.accounts.contribute(amount)?;

        Ok(())
    }

    pub fn check_contributions(ctx: Context<CheckContributions>) -> Result<()> {

        ctx.accounts.check_contributions()?;

        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {

        ctx.accounts.refund()?;

        Ok(())
    }

    // ---- new underwriting instructions ----

    /// Permissionless: anyone can call this after the deadline passes and
    /// the target is missed, to open the underwriting phase.
    pub fn enter_underwriting(ctx: Context<EnterUnderwriting>) -> Result<()> {
        ctx.accounts.enter_underwriting()
    }

    /// Permissionless: anyone can underwrite the shortfall during the
    /// underwriting phase. Tokens go to the vault; a claim position is
    /// created based on the bonding curve price.
    pub fn underwrite_shortfall(ctx: Context<UnderwriteShortfall>, amount: u64) -> Result<()> {
        ctx.accounts.underwrite_shortfall(amount, &ctx.bumps)
    }

    /// Maker-only: deposit enough tokens to repay all underwriter claims.
    /// Transitions state to Settled so underwriters can claim.
    pub fn repay_underwriters(ctx: Context<RepayUnderwriters>, amount: u64) -> Result<()> {
        ctx.accounts.repay_underwriters(amount)
    }

    /// Underwriter-only: withdraw your claim from the vault after the maker
    /// has settled. Closes the position account and returns rent.
    pub fn claim_underwriting(ctx: Context<ClaimUnderwriting>) -> Result<()> {
        ctx.accounts.claim_underwriting()
    }

    /// Permissionless crank: if the underwriting phase has expired without
    /// full coverage, transition state to Failed so contributors can refund.
    pub fn check_underwriting_status(ctx: Context<CheckUnderwritingStatus>) -> Result<()> {
        ctx.accounts.check_underwriting_status()
    }
}
