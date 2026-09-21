use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer, 
    Mint, 
    Token, 
    TokenAccount, 
    Transfer,
    burn,
    Burn,
};
use anchor_spl::{
    associated_token::AssociatedToken,
    metadata::{
        mpl_token_metadata::instructions::BurnV1CpiBuilder,
        Metadata, 
    },
};

use crate::{
    state::{
        Contributor, 
        Fundraiser
    }, 
    FundraiserError,
    SECONDS_TO_DAYS
};


/// Address of the Instructions sysvar, which Metaplex's BurnV1 requires.
const INSTRUCTIONS_SYSVAR_ID: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");


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
    // NFT RECEIPT ACCOUNTS
    #[account(
        mut,
        mint::decimals = 0,
        mint::authority = master_edition,
        mint::freeze_authority = master_edition,
    )]
    pub receipt_mint: Account<'info, Mint>,
    // The contributor's Associated Token Account.
    #[account(
        mut,
        associated_token::mint = receipt_mint,
        associated_token::authority = contributor,
    )]
    pub receipt_ata: Account<'info, TokenAccount>,
    /// CHECK: Metaplex metadata account. PDA derived using metaplex seeds
    /// Will be validated in the program with metaplex CPI.
    #[account(
        mut,
        seeds = [
            b"metadata",
            token_metadata_program.key().as_ref(),
            receipt_mint.key().as_ref(),
        ],
        bump,
        seeds::program = token_metadata_program.key()
    )]
    pub metadata_account: UncheckedAccount<'info>,
    /// CHECK: Metaplex Master Edition Account. PDA derived using metaplex seeds
    #[account(
        mut,
        seeds = [
            b"metadata",
            token_metadata_program.key().as_ref(),
            receipt_mint.key().as_ref(),
            b"edition",
        ],
        bump,
        seeds::program = token_metadata_program.key(),
    )]
    pub master_edition: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, Metadata>,

    /// CHECK: the Instructions sysvar, which Burnv1 requires. Pinned by address.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub sysvar_instructions: UncheckedAccount<'info>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> Refund<'info> {
    pub fn refund(&mut self) -> Result<()> {

        // Check if the fundraising duration has been reached
        let elapsed = Clock::get()?.unix_timestamp
            .checked_sub(self.fundraiser.time_started)
            .ok_or(FundraiserError::MathOverflow)?;
 
        require!(
            elapsed / SECONDS_TO_DAYS
                >= self.fundraiser.duration as i64,
            crate::FundraiserError::FundraiserNotEnded
        );

        require!(
            self.vault.amount < self.fundraiser.amount_to_raise,
            crate::FundraiserError::TargetMet
        );
        // Burning the receipt first through Metaplex. No receipt, no refund.
        // This burns the token and closes
        // the token account, metadata and master edition, returning their rent
        // to the contributor. The contributor already signed the transaction,
        // so this is a plain `invoke`, with no PDA seeds. It runs before the
        let metadata_program = self.token_metadata_program.to_account_info();
        let contributor = self.contributor.to_account_info();
        let metadata = self.metadata_account.to_account_info();
        let edition = self.master_edition.to_account_info();
        let mint = self.receipt_mint.to_account_info();
        let token = self.receipt_ata.to_account_info();
        let system_program = self.system_program.to_account_info();
        let sysvar_instructions = self.sysvar_instructions.to_account_info();
        let token_program = self.token_program.to_account_info();

        BurnV1CpiBuilder::new(&metadata_program)
            .authority(&contributor)
            .metadata(&metadata)
            .edition(Some(&edition))
            .mint(&mint)
            .token(&token)
            .system_program(&system_program)
            .sysvar_instructions(&sysvar_instructions)
            .spl_token_program(&token_program)
            .amount(1)
            .invoke()?;

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

        let refund_amount = self.contributor_account.amount;

        // Transfer the funds from the vault to the contributor
        transfer(cpi_ctx, refund_amount)?;

        // Burn the NFT issued

        // Update the fundraiser state by reducing the amount contributed
        self.fundraiser.current_amount = self.fundraiser.current_amount.checked_sub(refund_amount)
            .ok_or(FundraiserError::MathOverflow)?;

        Ok(())
    }
}
