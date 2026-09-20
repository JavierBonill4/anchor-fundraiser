use anchor_lang::prelude::*;
// The address of this locally built fundraiser program.
//
// This local ID is used for development and testing. Before submitting
// the pull request, we will restore the repository's original program ID
// so your personal key does not appear in the homework diff.
declare_id!("7WferfAMCt6f32DYucuQNhnSYdoV7SWSR92od8t1jDzW");

mod constants;
mod error;
mod instructions;
mod state;

pub use constants::*;
use error::*;
use instructions::*;

/// Public instructions exposed by the fundraiser program.
#[program]
pub mod fundraiser {
    use super::*;

    /// Creates a fundraiser with a target amount and duration.
    pub fn initialize(
        ctx: Context<Initialize>,
        amount: u64,
        duration: u8,
    ) -> Result<()> {
        ctx.accounts.initialize(
            amount,
            duration,
            &ctx.bumps,
        )?;

        Ok(())
    }

    /// Deposits fundraising tokens into the fundraiser vault.
    pub fn contribute(
        ctx: Context<Contribute>,
        amount: u64,
    ) -> Result<()> {
        ctx.accounts.contribute(amount)?;

        Ok(())
    }

    /// Allows the maker to collect the vault after reaching the target.
    pub fn check_contributions(
        ctx: Context<CheckContributions>,
    ) -> Result<()> {
        ctx.accounts.check_contributions()?;

        Ok(())
    }

    /// Returns a contributor's tokens after an unsuccessful fundraiser ends.
    pub fn refund(
        ctx: Context<Refund>,
    ) -> Result<()> {
        ctx.accounts.refund()?;

        Ok(())
    }

    /// Mints one non-transferable receipt NFT for a valid contributor.
    ///
    /// The receipt can later act as proof of eligibility for community
    /// benefits or off-chain reward-token airdrops.
    pub fn mint_receipt(
        ctx: Context<MintReceipt>,
    ) -> Result<()> {
        ctx.accounts.mint_receipt()?;

        Ok(())
    }
}