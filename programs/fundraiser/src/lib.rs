use anchor_lang::prelude::*;

declare_id!("7WferfAMCt6f32DYucuQNhnSYdoV7SWSR92od8t1jDzW");

mod state;
mod instructions;
mod error;
mod constants;

use instructions::*;
use error::*;
pub use constants::*;

#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    pub milestone: u8, // 1 = 25%, 2 = 50%, 3 = 75%
}

#[event]
pub struct WinnerDrawn {
    pub fundraiser: Pubkey,
    pub winning_ticket: u64,
    pub total_tickets: u64,
}

#[event]
pub struct PrizeClaimed {
    pub fundraiser: Pubkey,
    pub winner: Pubkey,
    pub winning_ticket: u64,
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

    pub fn draw(ctx: Context<Draw>) -> Result<()> {
        ctx.accounts.draw()?;
        Ok(())
    }

    pub fn claim_prize(ctx: Context<ClaimPrize>) -> Result<()> {
        ctx.accounts.claim_prize()?;
        Ok(())
    }    
}
