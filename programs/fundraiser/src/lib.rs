use anchor_lang::prelude::*;

declare_id!("8arsQKPz4bK6mAp4hPMAtudwBjWy1qodzXCEcguqccA8");

mod state;
mod instructions;
mod error;
mod constants;

#[cfg(test)]
mod tests;

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

    pub fn claim_token_reward(ctx: Context<ClaimTokenReward>) -> Result<()> {

        ctx.accounts.claim_token_reward()?;

        Ok(())
    }
}
