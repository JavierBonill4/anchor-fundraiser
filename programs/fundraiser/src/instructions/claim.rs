use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{
        mint_to,
        Mint,
        MintTo,
        Token,
        TokenAccount
    }
};

use crate::{
    state::{
        Contributor,
        Fundraiser
    },
    FundraiserError,
    REWARD_RATE,
    SECONDS_TO_DAYS
};

#[derive(Accounts)]
pub struct ClaimTokenReward<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        has_one = mint_to_raise,
        seeds = [b"fundraiser", fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    // Closing it makes the claim one-shot: a second claim finds no account.
    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        close = contributor,
    )]
    pub contributor_account: Account<'info, Contributor>,
    #[account(
        mut,
        seeds = [b"reward", fundraiser.key().as_ref()],
        bump,
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

impl<'info> ClaimTokenReward<'info> {
    pub fn claim_token_reward(&mut self) -> Result<()> {

        // Only after the window closes: otherwise a contributor could claim,
        // contribute again (init_if_needed recreates the account) and claim twice.
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                >= self.fundraiser.duration as i64,
            FundraiserError::FundraiserNotEnded
        );

        // current_amount, not vault.amount: checker may already have drained the vault.
        require!(
            self.fundraiser.current_amount >= self.fundraiser.amount_to_raise,
            FundraiserError::TargetNotMet
        );

        let rewards = reward_amount(
            self.contributor_account.amount,
            self.mint_to_raise.decimals,
            self.reward_mint.decimals,
        )
        .ok_or(FundraiserError::RewardOverflow)?;

        let cpi_accounts = MintTo {
            mint: self.reward_mint.to_account_info(),
            to: self.contributor_reward_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        // The fundraiser PDA is the mint authority, so it signs with its seeds
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.fundraiser.maker.as_ref(),
            &[self.fundraiser.bump],
        ]];

        let cpi_ctx = CpiContext::new_with_signer(self.token_program.key(), cpi_accounts, &signer_seeds);

        mint_to(cpi_ctx, rewards)?;

        Ok(())
    }
}

// rewards = amount * REWARD_RATE * 10^reward_decimals / 10^raise_decimals
//
// Multiply before dividing: dividing first rounds anything under one whole raised
// token to zero. And in u128: 18,447 USDC (6 decimals) times 10^9 already
// overflows a u64.
pub(crate) fn reward_amount(amount: u64, raise_decimals: u8, reward_decimals: u8) -> Option<u64> {
    let rewards = (amount as u128)
        .checked_mul(REWARD_RATE as u128)?
        .checked_mul(10u128.checked_pow(reward_decimals as u32)?)?
        .checked_div(10u128.checked_pow(raise_decimals as u32)?)?;

    u64::try_from(rewards).ok()
}
