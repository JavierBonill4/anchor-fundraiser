use anchor_lang::prelude::*;

use crate::constants::ANCHOR_DISCRIMINATOR;
use crate::state::{Fundraiser, WhitelistEntry};

#[derive(Accounts)]
pub struct WhitelistOps<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    /// CHECK: must make sure the contributor is a legit wallet
    pub contributor: UncheckedAccount<'info>,

    #[account(
        has_one = maker,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump
    )]
    pub fundraiser: Account<'info, Fundraiser>,

    #[account(
        init_if_needed,
        payer = maker,
        seeds = [b"whitelist", fundraiser.key().as_ref(), contributor.key().as_ref()],
        space = ANCHOR_DISCRIMINATOR + WhitelistEntry::INIT_SPACE,
        bump
    )]
    pub whitelist_entry: Account<'info, WhitelistEntry>,

    pub system_program: Program<'info, System>,
}
impl<'info> WhitelistOps<'info> {
    pub fn whitelist_contributor(
        &mut self,
        allowed: bool,
        bumps: &WhitelistOpsBumps,
    ) -> Result<()> {
        self.whitelist_entry.set_inner(WhitelistEntry {
            fundraiser: self.fundraiser.key(),
            contributor: self.contributor.key(),
            is_allowed: allowed,
            bump: bumps.whitelist_entry,
        });
        Ok(())
    }
}
