use anchor_lang::prelude::*;

declare_id!("7WferfAMCt6f32DYucuQNhnSYdoV7SWSR92od8t1jDzW");

mod state;
mod instructions;
mod error;
mod constants;

use instructions::*;
use error::*;
pub use constants::*;

/// Emitted the moment a campaign crosses a quarter-mark of its target.
///
/// Events are program logs, not state: emitted alongside the on-chain
/// `milestones_fired` bitmask, never instead of it. Anything off-chain can
/// subscribe to this and react without polling the vault balance.
#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    /// 0 = 25%, 1 = 50%, 2 = 75%
    pub quarter: u8,
    /// `current_amount` at the moment the mark was crossed.
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
