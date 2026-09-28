use anchor_lang::prelude::*;
use anchor_spl::token::{
    Mint,
    mint_to,
    MintTo,
    set_authority,
    SetAuthority,
    transfer,
    Token,
    TokenAccount,
    Transfer
};

use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::associated_token::AssociatedToken;

use crate::{
    state::{
        Contributor, 
        Fundraiser,
        Receipt
    }, FundraiserError, 
    ANCHOR_DISCRIMINATOR, 
    MAX_CONTRIBUTION_PERCENTAGE, 
    PERCENTAGE_SCALER, SECONDS_TO_DAYS
};

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        has_one = mint_to_raise,
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
    #[account(
        init,
        payer = contributor,
        seeds = [b"receipt", fundraiser.key().as_ref(), fundraiser.issue_count.to_le_bytes().as_ref()],
        bump,
        space = ANCHOR_DISCRIMINATOR + Receipt::INIT_SPACE,
    )]
    pub receipt: Account<'info, Receipt>,
    #[account(
        init,
        payer = contributor,
        seeds = [b"receipt_mint", fundraiser.key().as_ref(), fundraiser.issue_count.to_le_bytes().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = fundraiser,
    )]
    pub receipt_mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = contributor,
        associated_token::mint = receipt_mint,
        associated_token::authority = contributor
    )]
    pub contributor_receipt_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> Contribute<'info> {
    pub fn contribute(&mut self, amount: u64, bumps: &ContributeBumps) -> Result<()> {

        // Check that the contribution is at least one whole token.
        //
        // The previous form was `1_u8.pow(decimals)`, and 1 raised to any power is 1
        // — so the check only ever rejected a contribution of a single raw unit.
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::ContributionTooSmall)?;

        require!(amount >= one_token, FundraiserError::ContributionTooSmall);

        // Check if the amount to contribute is less than the maximum allowed contribution
        require!(
            amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER, 
            FundraiserError::ContributionTooBig
        );

        // Check if the fundraising duration has been reached
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                < self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserEnded
        );

        // Check if the maximum contributions per contributor have been reached
        require!(
            (self.contributor_account.amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER)
                && (self.contributor_account.amount + amount <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE) / PERCENTAGE_SCALER),
            FundraiserError::MaximumContributionsReached
        );

        // Transfer the funds from the contributor to the vault.
        // As of Anchor 1.0 a CpiContext takes the program's *address*, not its
        // AccountInfo.
        let cpi_accounts = Transfer {
            from: self.contributor_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.contributor.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(self.token_program.key(), cpi_accounts);

        // Transfer the funds from the contributor to the vault
        transfer(cpi_ctx, amount)?;

        // Update the fundraiser and contributor accounts with the new amounts
        self.fundraiser.current_amount += amount;

        self.contributor_account.amount += amount;
        self.receipt.amount = amount;
        self.receipt.bump = bumps.receipt;
                // The fundraiser PDA is the mint authority, so it has to "sign".
        // A PDA has no private key; it signs by repeating the seeds that made it.
        // These must match the fundraiser's seeds in the struct exactly:
        // [b"fundraiser", maker, bump]
        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.fundraiser.maker.as_ref(),   // checker.rs has a `maker` account; we don't, so read it off the fundraiser
            &[self.fundraiser.bump],
        ]];

        // Which accounts the token program needs for a mint
        let mint_accounts = MintTo {
            mint: self.receipt_mint.to_account_info(),               // what to mint
            to: self.contributor_receipt_ata.to_account_info(),      // where it goes
            authority: self.fundraiser.to_account_info(),            // who's allowed to mint
        };

        let mint_ctx = CpiContext::new_with_signer(
            self.token_program.key(),
            mint_accounts,
            &signer_seeds,
        );

        // Mint exactly 1: it's a one-of-one
        mint_to(mint_ctx, 1)?;
                // Remove the mint authority so no second copy can ever be minted.
        // The fundraiser is the current authority, so it signs with the same seeds.
        let authority_accounts = SetAuthority {
            current_authority: self.fundraiser.to_account_info(),
            account_or_mint: self.receipt_mint.to_account_info(),
        };

        let authority_ctx = CpiContext::new_with_signer(
            self.token_program.key(),
            authority_accounts,
            &signer_seeds,          // reuse the seeds from the mint step
        );

        // MintTokens = the "can mint" permission; None = nobody has it
        set_authority(authority_ctx, AuthorityType::MintTokens, None)?;


        self.fundraiser.issue_count = self.fundraiser.issue_count.checked_add(1).ok_or(FundraiserError::Overflow)?;

        Ok(())
    }
}
