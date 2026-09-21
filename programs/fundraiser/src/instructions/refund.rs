use anchor_lang::prelude::*;
use anchor_spl::token::{
    burn,
    transfer, 
    Burn,
    Mint, 
    Token, 
    TokenAccount, 
    Transfer
};

use crate::{
    state::{
        Contributor, 
        Fundraiser
    }, 
    FundraiserError,
    SECONDS_TO_DAYS
};

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub maker: SystemAccount<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
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
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser
    )]
    pub vault: Account<'info, TokenAccount>,
    // Same reward mint contribute minted from, re-derived from its seeds.
    #[account(
        mut,
        seeds = [b"reward", fundraiser.key().as_ref()],
        bump,
    )]
    pub reward_mint: Account<'info, Mint>,
    // The contributor's own reward token account. No `init_if_needed` here —
    // if `contributor_account` exists at all, `contribute` already created
    // this ATA and minted into it, so it must already exist.
    #[account(
        mut,
        associated_token::mint = reward_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_reward_ata: Account<'info, TokenAccount>,
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
            FundraiserError::FundraiserNotEnded
        );

        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            FundraiserError::TargetMet
        );

        // Transfer the funds back to the contributor
        // CPI to the token program to transfer the funds
        // As of Anchor 1.0 a CpiContext takes the program's address, not its AccountInfo.
        let cpi_program = self.token_program.key();

        // Transfer the funds from the vault to the contributor
        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.contributor_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        // Signer seeds to sign the CPI on behalf of the fundraiser account
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        // CPI context with signer since the fundraiser account is a PDA
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, &signer_seeds);

        // Transfer the funds from the vault to the contributor
        transfer(cpi_ctx, self.contributor_account.amount)?;
        //----------------------------
        //--- Claw back the reward ---
        //----------------------------
        //
        // Without this, a contributor could contribute, receive the reward
        // immediately, wait for the campaign to fail, and refund — walking
        // away with both their original tokens *and* the reward minted for
        // money they no longer have in the program. Repeatable, and it costs
        // them nothing but time. Burning here is what keeps "you get a
        // reward for successfully backing a campaign" actually true, instead
        // of "you get a reward for briefly touching the vault."
        //
        // This burn is signed by the contributor's own signature, not the
        // PDA's seeds — they, not the program, are the owner of their reward
        // token account, so only they can authorise spending from it.
        if self.contributor_account.reward_amount > 0 {
            let burn_accounts = Burn {
                mint: self.reward_mint.to_account_info(),
                from: self.contributor_reward_ata.to_account_info(),
                authority: self.contributor.to_account_info(),
            };
            let burn_ctx = CpiContext::new(self.token_program.key(), burn_accounts);
            burn(burn_ctx, self.contributor_account.reward_amount)?;
        }

        // Update the fundraiser state by reducing the amount contributed.
        // Checked — the original line here was a bare `-=`.
        self.fundraiser.current_amount = self
            .fundraiser
            .current_amount
            .checked_sub(self.contributor_account.amount)
            .ok_or(FundraiserError::Underflow)?;

        Ok(())
    }
}
