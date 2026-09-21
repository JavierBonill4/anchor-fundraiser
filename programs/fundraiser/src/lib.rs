use anchor_lang::prelude::*;

declare_id!("GQLxrcNb6xyZh3LLpmpSq4SzkYMNfuQh5sNoyiE9CE9L");

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

    pub fn initialize(ctx: Context<Initialize>, amount: u64, duration: u8, reveal_hash: [u8; 32], reward_bps: u16,) -> Result<()> {

        ctx.accounts.initialize(amount, duration, reveal_hash, reward_bps, &ctx.bumps)?;

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

    pub fn draw_winner(ctx: Context<DrawWinner>, secret: [u8; 32]) -> Result<()> {
        ctx.accounts.draw_winner(secret)?;
        Ok(())
    }

    pub fn claim_penalty(ctx: Context<ClaimPenalty>) -> Result<()> {
        ctx.accounts.claim_penalty()?;
        Ok(())
    }
}
