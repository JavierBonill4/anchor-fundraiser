use anchor_lang::prelude::*;
use anchor_spl::token::{
    Mint, 
    transfer, 
    Token, 
    TokenAccount, 
    Transfer,
    mint_to,
    MintTo,
};
use anchor_spl::{
    associated_token::AssociatedToken,
    metadata::{
        mpl_token_metadata::{
            instructions::{CreateMasterEditionV3CpiBuilder, CreateMetadataAccountV3CpiBuilder},
            types::DataV2,
        },
        Metadata,
    },
};

use crate::{
    state::{
        Contributor, 
        Fundraiser
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
    // NFT RECIPT ACCOUNTS
    // New NFT mint account.
    #[account(
        init,
        payer = contributor,
        mint::decimals = 0,
        mint::authority = fundraiser,
        mint::freeze_authority = fundraiser,
    )]
    pub receipt_mint: Account<'info, Mint>,
    // The contributor's Associated Token Account.
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint = receipt_mint,
        associated_token::authority = contributor,
    )]
    pub receipt_ata: Account<'info, TokenAccount>,
    /// CHECK: Metaplex metadata account. PDA derived using metaplex seeds
    /// Will be validated in the program with metaplex CPI.
    #[account(mut)]
    pub metadata_account: UncheckedAccount<'info>,
    /// CHECK: Metaplex Master Edition Account. PDA derived using metaplex seeds
    #[account(mut)]
    pub master_edition: UncheckedAccount<'info>,
    /// CHECK: Metaplex Token Metadata Program ID.
    pub token_metadata_program: Program<'info, Metadata>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
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

        let max_per_contributor = self.fundraiser.amount_to_raise.checked_mul(MAX_CONTRIBUTION_PERCENTAGE)
            .ok_or(FundraiserError::MathOverflow)?
            .checked_div(PERCENTAGE_SCALER)
            .ok_or(FundraiserError::MathOverflow)?;

        // Check if the amount to contribute is less than the maximum allowed contribution
        require!(amount <= max_per_contributor, FundraiserError::ContributionTooBig);

        // Check if the fundraising duration has been reached
        let elapsed = Clock::get()?.unix_timestamp
            .checked_sub(self.fundraiser.time_started)
            .ok_or(FundraiserError::MathOverflow)?;

        require!(
            elapsed / SECONDS_TO_DAYS
                < self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserEnded
        );

        let new_total = self.contributor_account.amount
            .checked_add(amount).ok_or(FundraiserError::MathOverflow)?;
        // Check if the maximum contributions per contributor have been reached
        require!(new_total <= max_per_contributor, FundraiserError::MaximumContributionsReached);

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

        // Give an NFT receipt to the contributor to show he/she has contributed.
        let maker = self.fundraiser.maker;
        let bump = [self.fundraiser.bump];
        let signer_seeds: &[&[&[u8]]] = &[&[b"fundraiser", maker.as_ref(), &bump]];
        msg!("About to do NFT minting");

        // Mint exactly one token to the contributor. The fundraiser PDA is the
        // mint authority (set in the accounts struct), so it signs.
        mint_to(
            CpiContext::new_with_signer(
                self.token_program.key(),
                MintTo {
                    mint: self.receipt_mint.to_account_info(),
                    to: self.receipt_ata.to_account_info(),
                    authority: self.fundraiser.to_account_info(),
                },
                signer_seeds,
            ),
            1,
        )?;

        // The builders borrow AccountInfos, so bind them first.
        let metadata_program = self.token_metadata_program.to_account_info();
        let metadata = self.metadata_account.to_account_info();
        let edition = self.master_edition.to_account_info();
        let mint = self.receipt_mint.to_account_info();
        let authority = self.fundraiser.to_account_info();
        let payer = self.contributor.to_account_info();
        let system_program = self.system_program.to_account_info();
        let token_program = self.token_program.to_account_info();

        // Metadata: name, symbol, uri. No `.rent(...)` call, so no rent account.
        CreateMetadataAccountV3CpiBuilder::new(&metadata_program)
            .metadata(&metadata)
            .mint(&mint)
            .mint_authority(&authority)
            .payer(&payer)
            .update_authority(&authority, true)
            .system_program(&system_program)
            .data(DataV2 {
                name: "Fundraiser Receipt".to_string(),               // max 32 bytes
                symbol: "RCPT".to_string(),                           // max 10 bytes
                uri: "https://example.com/receipt.json".to_string(),  // max 200 bytes
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            })
            .is_mutable(false)
            .invoke_signed(signer_seeds)?;

        // Master edition: this is what makes the mint an NFT.
        CreateMasterEditionV3CpiBuilder::new(&metadata_program)
            .edition(&edition)
            .mint(&mint)
            .update_authority(&authority)
            .mint_authority(&authority)
            .payer(&payer)
            .metadata(&metadata)
            .token_program(&token_program)
            .system_program(&system_program)
            .max_supply(0)
            .invoke_signed(signer_seeds)?;

        // Update the fundraiser and contributor accounts with the new amounts
        self.fundraiser.current_amount = self.fundraiser.current_amount.checked_add(amount)
            .ok_or(FundraiserError::MathOverflow)?;

        self.contributor_account.amount = new_total;

        Ok(())
    }
}
