use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{
        mint_to, 
        transfer, 
        Mint, 
        MintTo, 
        Token, 
        TokenAccount, 
        Transfer
    },
};

use crate::{
    state::{
        Contributor, 
        Fundraiser
    },
    FundraiserError, ANCHOR_DISCRIMINATOR, MAX_CONTRIBUTION_PERCENTAGE, PERCENTAGE_SCALER, REWARD_PER_TOKEN, SECONDS_TO_DAYS,
};

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        has_one = reward_mint @ FundraiserError::InvalidRewardMint,
        seeds = [b"fundraiser".as_ref(), fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]

    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        init_if_needed,
        payer = contributor,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        space = ANCHOR_DISCRIMINATOR + Contributor::INIT_SPACE,
    )]

    pub contributor_account: Account<'info, Contributor>,
    #[account(
        mut, 
        associated_token::mint = mint_to_raise, 
        associated_token::authority = contributor
    )]

    pub contributor_ata: Account<'info, TokenAccount>,
    #[account(
        mut, 
        associated_token::mint = fundraiser.mint_to_raise, 
        associated_token::authority = fundraiser
    )]

    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]                     
    pub reward_mint: Account<'info, Mint>,          // reward token account
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint = reward_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_reward_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> Contribute<'info> {
    /// reward = amount * REWARD_PER_TOKEN * 10^reward_dec / 10^raise_dec
    /// Multiply first, divide last, in u128. Rounds down: never mints more than owed.
    fn reward_for(&self, amount: u64) -> Result<u64> {
        let raise_scale = 10u128.checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::Overflow)?;
        let reward_scale = 10u128.checked_pow(self.reward_mint.decimals as u32)
            .ok_or(FundraiserError::Overflow)?;
        let reward = (amount as u128)
            .checked_mul(REWARD_PER_TOKEN as u128).ok_or(FundraiserError::Overflow)?
            .checked_mul(reward_scale).ok_or(FundraiserError::Overflow)?
            / raise_scale;
        u64::try_from(reward).map_err(|_| error!(FundraiserError::Overflow))
    }

    pub fn contribute(&mut self, amount: u64) -> Result<()> {
        // 1 · at least one whole token
        let one_token = 10u64.checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::ContributionTooSmall)?;
        require!(amount >= one_token, FundraiserError::ContributionTooSmall);

        // 2 · at most 10% of the target, per transfer
        let cap = self.fundraiser.amount_to_raise
            .checked_mul(MAX_CONTRIBUTION_PERCENTAGE).ok_or(FundraiserError::Overflow)?
            / PERCENTAGE_SCALER;
        require!(amount <= cap, FundraiserError::ContributionTooBig);

        // 3 · window still open
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                < self.fundraiser.duration as i64,
            FundraiserError::FundraiserEnded
        );

        // 4 · wallet cap
        let new_wallet_total = self.contributor_account.amount
            .checked_add(amount).ok_or(FundraiserError::Overflow)?;
        require!(new_wallet_total <= cap, FundraiserError::MaximumContributionsReached);

        let reward = self.reward_for(amount)?;
        require!(reward > 0, FundraiserError::RewardTooSmall);

        // effects first
        self.fundraiser.current_amount = self.fundraiser.current_amount
            .checked_add(amount).ok_or(FundraiserError::Overflow)?;
        self.contributor_account.amount = new_wallet_total;
        self.contributor_account.rewards_minted = self.contributor_account.rewards_minted
            .checked_add(reward).ok_or(FundraiserError::Overflow)?;

        // contributor -> vault (contributor signs)
        transfer(
            CpiContext::new(self.token_program.key(), Transfer {
                from: self.contributor_ata.to_account_info(),
                to: self.vault.to_account_info(),
                authority: self.contributor.to_account_info(),
            }),
            amount,
        )?;

        // mint the reward (fundraiser PDA signs)
        let maker = self.fundraiser.maker;
        let bump = [self.fundraiser.bump];
        let signer_seeds: [&[&[u8]]; 1] = [&[b"fundraiser".as_ref(), maker.as_ref(), &bump]];
        mint_to(
            CpiContext::new_with_signer(
                self.token_program.key(),
                MintTo {
                    mint: self.reward_mint.to_account_info(),
                    to: self.contributor_reward_ata.to_account_info(),
                    authority: self.fundraiser.to_account_info(),
                },
                &signer_seeds,
            ),
            reward,
        )?;
        Ok(())
    }
}