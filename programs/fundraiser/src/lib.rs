use anchor_lang::prelude::*;

declare_id!("9V2cdwVpmfkTsYaLiFkyFLnv1cuN9s3P3ebuMXc4niN3");

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

    pub fn contribute<'a>(ctx: Context<'a, Contribute<'a>>, amount: u64) -> Result<()> {

        ctx.accounts.contribute(amount, ctx.remaining_accounts)?;

        Ok(())
    }

    pub fn check_contributions(ctx: Context<CheckContributions>) -> Result<()> {

        ctx.accounts.check_contributions()?;

        Ok(())
    }

    pub fn deposit_match(ctx: Context<DepositMatch>, amount: u64) -> Result<()> {
        ctx.accounts.deposit_match(amount)?;
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {

        ctx.accounts.refund()?;

        Ok(())
    }
}
