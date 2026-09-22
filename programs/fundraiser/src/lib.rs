use anchor_lang::prelude::*;

declare_id!("FXCQVUN1EmhUd4GaLAaYuAB9meUBbQMN9JMoiCzKVbg3");

mod state;
mod instructions;
mod error;
mod constants;

use instructions::*;
use error::*;
pub use constants::*;
// event based 
#[event]
pub struct MilestoneReached{
    pub fundraiser: Pubkey,
    pub quarter: u8,
    pub amount: u64,
}
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
}
