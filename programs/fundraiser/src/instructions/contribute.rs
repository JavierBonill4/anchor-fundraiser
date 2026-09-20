use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{mint_to, transfer, Mint, MintTo, Token, TokenAccount, Transfer},
};

use crate::{
    state::{Contributor, Fundraiser},
    FundraiserError, ANCHOR_DISCRIMINATOR, MAX_CONTRIBUTION_PERCENTAGE, PERCENTAGE_SCALER,
    SECONDS_TO_DAYS,
};

#[derive(Accounts)]
pub struct Contribute<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    pub mint_to_raise: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"receipt".as_ref(), fundraiser.maker.as_ref()],
        bump = fundraiser.receipt_bump,
    )]
    pub receipt_mint: Box<Account<'info, Mint>>,
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
        init_if_needed,
        payer = contributor,
        associated_token::mint = receipt_mint,
        associated_token::authority = contributor
    )]
    pub contributor_receipt_ata: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        associated_token::mint = fundraiser.mint_to_raise,
        associated_token::authority = fundraiser
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> Contribute<'info> {
    pub fn contribute(&mut self, amount: u64) -> Result<()> {
        // Check that the contribution is at least one whole token.
        //
        // The previous form was `1_u8.pow(decimals)`, and 1 raised to any power is 1
        // — so the check only ever rejected a contribution of a single raw unit.
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::ContributionTooSmall)?;

        require!(amount >= one_token, FundraiserError::ContributionTooSmall);

        // Check if the amount to contribute is less than the maximum allowed contribution
        // LOW: This check doesn't provide sybil resistance.
        // This can be a major centralisation risk if the contribition goves governance rights and be high severity bug
        require!(
            amount
                <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE)
                    / PERCENTAGE_SCALER,
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
        // The following condition and ContributionTooBig can be collapsed into one
        // INFO: if current + new <= max => new <= max and current <= max, hence 3 separate conditions are wasted CU
        require!(
            (self.contributor_account.amount
                <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE)
                    / PERCENTAGE_SCALER)
                && (self.contributor_account.amount + amount
                    <= (self.fundraiser.amount_to_raise * MAX_CONTRIBUTION_PERCENTAGE)
                        / PERCENTAGE_SCALER),
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

        let one_receipt_token = 10u128
            .checked_pow(self.receipt_mint.decimals as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        let receipt_amount: u64 = (amount as u128)
            .checked_mul(one_receipt_token)
            .ok_or(ProgramError::ArithmeticOverflow)?
            .checked_div(one_token as u128)
            .ok_or(ProgramError::ArithmeticOverflow)?
            .try_into()?;

        let cpi_accounts = MintTo {
            mint: self.receipt_mint.to_account_info(),
            to: self.contributor_receipt_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };
        let maker_key = self.fundraiser.maker.key();
        let bump = self.fundraiser.bump;
        let seeds: &[&[u8]] = &[b"fundraiser".as_ref(), maker_key.as_ref(), &[bump]];
        let signer_seeds = &[seeds];

        let cpi_ctx =
            CpiContext::new_with_signer(self.token_program.key(), cpi_accounts, signer_seeds);
        mint_to(cpi_ctx, receipt_amount)?;

        // Update the fundraiser and contributor accounts with the new amounts
        // INFO: this is a bottleneck since multiple contributions would need to be processed sequentially
        // Alternate read the balance of vault directly, prone to donation attack.
        // There is similar bottleneck in minting and burning same tokens since they have to track supply
        self.fundraiser.current_amount += amount;

        self.contributor_account.amount += amount;

        Ok(())
    }
}
