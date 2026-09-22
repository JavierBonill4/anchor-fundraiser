use anchor_lang::prelude::*;

declare_id!("CpzTbWuVmwXdJYX2zkeWJrdAHSPnWW8wr8M88jyUNmxE");

mod constants;
mod error;
mod instructions;
mod state;

pub use constants::*;
use error::*;
use instructions::*;

#[program]
pub mod fundraiser {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        amount: u64,
        duration: u8,
        reward_amount: u64,
    ) -> Result<()> {
        ctx.accounts
            .initialize(amount, duration, reward_amount, &ctx.bumps)
    }

    pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        ctx.accounts.contribute(amount)?;

        Ok(())
    }

    pub fn check_contributions(ctx: Context<CheckContributions>) -> Result<()> {
        ctx.accounts.check_contributions(&ctx.bumps)?;
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        ctx.accounts.refund()?;

        Ok(())
    }

    pub fn claim_reward(ctx: Context<ClaimReward>) -> Result<()> {
        ctx.accounts.claim_reward()
    }
}
