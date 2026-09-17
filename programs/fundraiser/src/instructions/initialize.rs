use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::spl_token::instruction::AuthorityType,
    token::{mint_to, set_authority, Mint, MintTo, SetAuthority, Token, TokenAccount},
};

use crate::{state::Fundraiser, FundraiserError, ANCHOR_DISCRIMINATOR, MIN_AMOUNT_TO_RAISE};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        init,
        payer = maker,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump,
        space = ANCHOR_DISCRIMINATOR + Fundraiser::INIT_SPACE,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        init,
        payer = maker,
        seeds = [b"shares", fundraiser.key().as_ref()],
        mint::decimals = mint_to_raise.decimals,
        mint::authority = fundraiser,
        bump,
    )]
    pub ownership_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = maker,
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = maker,
        associated_token::mint = ownership_mint,
        associated_token::authority = fundraiser,
    )]
    pub ownership_vault: Account<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> Initialize<'info> {
    pub fn initialize(&mut self, amount: u64, duration: u8, bumps: &InitializeBumps) -> Result<()> {
        // Check if the amount to raise meets the minimum amount required.
        //
        // MIN_AMOUNT_TO_RAISE is a count of whole tokens, so it has to be scaled by
        // the mint's decimals to become a raw amount. `MIN.pow(decimals)` was doing
        // something else entirely: 3.pow(6) is 729, or 0.000729 of a token.
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::InvalidAmount)?;
        let minimum = MIN_AMOUNT_TO_RAISE
            .checked_mul(one_token)
            .ok_or(FundraiserError::InvalidAmount)?;

        require!(amount > minimum, FundraiserError::InvalidAmount);

        // Initialize the fundraiser account
        self.fundraiser.set_inner(Fundraiser {
            maker: self.maker.key(),
            mint_to_raise: self.mint_to_raise.key(),
            amount_to_raise: amount,
            current_amount: 0,
            time_started: Clock::get()?.unix_timestamp,
            duration,
            bump: bumps.fundraiser,
        });

        // Signer seeds so the fundraiser PDA can act as the share mint's authority
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        // Mint the whole share supply up front, one share per raw unit of the target.
        // The share vault running dry is what stops the campaign overfunding.
        mint_to(
            CpiContext::new_with_signer(
                self.token_program.key(),
                MintTo {
                    mint: self.ownership_mint.to_account_info(),
                    to: self.ownership_vault.to_account_info(),
                    authority: self.fundraiser.to_account_info(),
                },
                &signer_seeds,
            ),
            amount,
        )?;

        // Revoke the mint authority so the supply is fixed forever
        set_authority(
            CpiContext::new_with_signer(
                self.token_program.key(),
                SetAuthority {
                    current_authority: self.fundraiser.to_account_info(),
                    account_or_mint: self.ownership_mint.to_account_info(),
                },
                &signer_seeds,
            ),
            AuthorityType::MintTokens,
            None,
        )?;
        Ok(())
    }
}
