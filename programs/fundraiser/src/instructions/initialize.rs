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
    state::Fundraiser, FundraiserError, ANCHOR_DISCRIMINATOR, MIN_AMOUNT_TO_RAISE
};

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
        associated_token::mint = mint_to_raise,
        associated_token::authority = fundraiser,
    )]
    pub vault: Account<'info, TokenAccount>,
    /// The receipt (badge) mint this campaign issues to contributors. Derived
    /// from the fundraiser's own seeds, so callers resolve it without ever
    /// seeing it: PDA = [b"reward-mint", fundraiser]. Zero decimals — a badge,
    /// not a currency. Its only mint authority is the fundraiser PDA, and it
    /// is never frozen, so badges stay transferable. `mint_to` below gives
    /// supply 1 to the maker; `claim_receipt` is the only other mint.
    #[account(
        init,
        payer = maker,
        seeds = [b"reward-mint", fundraiser.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = fundraiser,
        mint::freeze_authority = fundraiser,
    )]
    pub reward_mint: Account<'info, Mint>,
    /// The maker's ATA for the badge mint, holding its copy of supply 1.
    /// Derived from `reward_mint`, so callers resolve it from the seeds too.
    #[account(
        init,
        payer = maker,
        associated_token::mint = reward_mint,
        associated_token::authority = maker,
    )]
    pub maker_receipt_ata: Account<'info, TokenAccount>,
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
            // The badge mint exists from day one; nothing has been claimed yet.
            reward_mint: self.reward_mint.key(),
            receipts_minted: 0,
        });

        // Give the maker supply 1 of the badge mint, so a one-person campaign
        // (target of one whole token, maker is the only eligible contributor)
        // can still be fully resolved on chain.
        let cpi_accounts = MintTo {
            mint: self.reward_mint.to_account_info(),
            to: self.maker_receipt_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];
        let cpi_ctx = CpiContext::new_with_signer(
            self.token_program.key(),
            cpi_accounts,
            &signer_seeds,
        );
        mint_to(cpi_ctx, 1)?;

        Ok(())
    }
}