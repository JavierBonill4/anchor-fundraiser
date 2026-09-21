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

    /// Settles a successful campaign and draws the winning ticket in the same
    /// breath.
    pub fn check_contributions(ctx: Context<CheckContributions>) -> Result<()> {

        ctx.accounts.check_contributions()?;

        Ok(())
    }

    /// The holder of the winning ticket collects the overshoot.
    pub fn claim_prize(ctx: Context<ClaimPrize>) -> Result<()> {

        ctx.accounts.claim_prize()?;

        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {

        ctx.accounts.refund()?;

        Ok(())
    }
}
