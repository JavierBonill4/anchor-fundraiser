use anchor_lang::prelude::*;
use anchor_spl::token::{
    burn,
    transfer,
    Burn, 
    Mint, 
    Token, 
    TokenAccount, 
    Transfer,
};

use crate::{
    SECONDS_TO_DAYS, error::FundraiserError, state::{
        Contributor, 
        Fundraiser
    }
};

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(mut)]
    pub reward_mint: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
        has_one = reward_mint @ FundraiserError::InvalidRewardMint,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        close = contributor,
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
        associated_token::mint = reward_mint,
        associated_token::authority = contributor
    )]
    pub contributor_reward_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> Refund<'info> {
    pub fn refund(&mut self) -> Result<()> {

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
 
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                >= self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserNotEnded
        );

        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            crate::FundraiserError::TargetMet
        );

                let owed_back = self.contributor_account.amount;
        let rewards = self.contributor_account.rewards_minted;

        // burn what this wallet was paid (contributor signs); named error, not InsufficientFunds
        require!(self.contributor_reward_ata.amount >= rewards, FundraiserError::RewardsNotHeld);
        burn(
            CpiContext::new(self.token_program.key(), Burn {
                mint: self.reward_mint.to_account_info(),
                from: self.contributor_reward_ata.to_account_info(),
                authority: self.contributor.to_account_info(),
            }),
            rewards,
        )?;

        // original refund, PDA signs
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];
        transfer(
            CpiContext::new_with_signer(self.token_program.key(), Transfer {
                from: self.vault.to_account_info(),
                to: self.contributor_ata.to_account_info(),
                authority: self.fundraiser.to_account_info(),
            }, &signer_seeds),
            owed_back,
        )?;

        self.fundraiser.current_amount = self.fundraiser.current_amount
            .checked_sub(owed_back).ok_or(FundraiserError::Overflow)?;
        
        Ok(())

        // // Transfer the funds back to the contributor
        // // CPI to the token program to transfer the funds
        // // As of Anchor 1.0 a CpiContext takes the program's address, not its AccountInfo.
        // let cpi_program = self.token_program.key();

        // // Transfer the funds from the vault to the contributor
        // let cpi_accounts = Transfer {
        //     from: self.vault.to_account_info(),
        //     to: self.contributor_ata.to_account_info(),
        //     authority: self.fundraiser.to_account_info(),
        // };

        // // Signer seeds to sign the CPI on behalf of the fundraiser account
        // let signer_seeds: [&[&[u8]]; 1] = [&[
        //     b"fundraiser".as_ref(),
        //     self.maker.to_account_info().key.as_ref(),
        //     &[self.fundraiser.bump],
        // ]];

        // // CPI context with signer since the fundraiser account is a PDA
        // let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);

        // // Transfer the funds from the vault to the contributor
        // transfer(cpi_ctx, self.contributor_account.amount)?;

        // // Update the fundraiser state by reducing the amount contributed
        // self.fundraiser.current_amount -= self.contributor_account.amount;

        // Ok(())
    }
}