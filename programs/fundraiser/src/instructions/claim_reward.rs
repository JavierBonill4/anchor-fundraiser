use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{mint_to, Mint, MintTo, Token, TokenAccount},
};

use crate::{
    state::{Contributor, Fundraiser},
    FundraiserError, REWARD_MINT_SEED, REWARD_RATE,
};

/// Claim the reward tokens earned by contributing to a campaign that hit its
/// target.
///
/// Rewards are *claimed*, not minted at contribution time, and that is the
/// whole point: a contributor to a campaign that fails gets a refund and
/// nothing else, so nobody is ever paid for a contribution that was handed
/// back. It also keeps `contribute` and `refund` exactly as they were.
#[derive(Accounts)]
pub struct ClaimReward<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    /// Only used to derive the fundraiser PDA and sign as it.
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        has_one = mint_to_raise,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
    )]
    pub contributor_account: Account<'info, Contributor>,
    /// One reward mint per campaign, owned by the fundraiser PDA.
    ///
    /// Created lazily by the first claimer rather than at `initialize`, so
    /// none of the four original instructions had to change. Same decimals as
    /// the mint being raised, which is what lets REWARD_RATE be an exact
    /// whole-token ratio.
    #[account(
        init_if_needed,
        payer = contributor,
        seeds = [REWARD_MINT_SEED, fundraiser.key().as_ref()],
        bump,
        mint::decimals = mint_to_raise.decimals,
        mint::authority = fundraiser,
    )]
    pub reward_mint: Account<'info, Mint>,
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint = reward_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_reward_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> ClaimReward<'info> {
    pub fn claim_reward(&mut self) -> Result<()> {
        // Only a campaign that actually hit its target pays out.
        require!(
            self.fundraiser.current_amount >= self.fundraiser.amount_to_raise,
            FundraiserError::TargetNotMet
        );

        // `init_if_needed` on the contributor account in `contribute` means an
        // account can exist with a zero balance, so this is a real case and
        // not just defensive noise.
        require!(
            self.contributor_account.amount > 0,
            FundraiserError::NothingToClaim
        );

        // The condition above stays true forever once it is true, so without a
        // flag this would pay out on every call.
        require!(
            !self.contributor_account.rewards_claimed,
            FundraiserError::RewardAlreadyClaimed
        );

        let reward_amount = self
            .contributor_account
            .amount
            .checked_mul(REWARD_RATE)
            .ok_or(FundraiserError::RewardOverflow)?;

        // Set the flag before the CPI. If the mint fails the whole instruction
        // unwinds and the flag goes back with it, so ordering costs nothing
        // and protects against a partially-successful mint later on.
        self.contributor_account.rewards_claimed = true;

        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        // As of Anchor 1.0 a CpiContext takes the program's address, not its
        // AccountInfo.
        let cpi_ctx = CpiContext::new_with_signer(
            self.token_program.key(),
            MintTo {
                mint: self.reward_mint.to_account_info(),
                to: self.contributor_reward_ata.to_account_info(),
                authority: self.fundraiser.to_account_info(),
            },
            &signer_seeds,
        );

        mint_to(cpi_ctx, reward_amount)?;

        Ok(())
    }
}
