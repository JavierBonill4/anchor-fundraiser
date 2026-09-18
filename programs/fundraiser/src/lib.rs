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

    pub fn initialize(ctx: Context<Initialize>, id: u64, amount: u64, duration: u8) -> Result<()> {

        ctx.accounts.initialize(id, amount, duration, &ctx.bumps)?;

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

    /// Permissionless cleanup for a campaign that missed its target.
    pub fn close_campaign(ctx: Context<CloseCampaign>) -> Result<()> {

        ctx.accounts.close_campaign()?;

        Ok(())
    }
}
