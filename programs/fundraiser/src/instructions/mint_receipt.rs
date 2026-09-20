use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{
        freeze_account,
        mint_to,
        FreezeAccount,
        Mint,
        MintTo,
        Token,
        TokenAccount,
    },
};

use crate::{
    state::{
        Contributor,
        Fundraiser,
    },
    FundraiserError,
};

/// Accounts required to mint one backer receipt NFT.
///
/// The receipt mint is unique to:
/// - one fundraiser
/// - one contributor
///
/// Its PDA seeds are:
/// ["receipt", fundraiser, contributor]
#[derive(Accounts)]
pub struct MintReceipt<'info> {
    /// The contributor receiving the receipt.
    ///
    /// The contributor signs the transaction and pays the rent required
    /// to create the receipt mint and associated token account.
    #[account(mut)]
    pub contributor: Signer<'info>,

    /// The fundraiser associated with this receipt.
    ///
    /// This PDA also acts as the receipt's mint and freeze authority.
    /// A PDA has no private key, so only this program can sign for it.
    #[account(
        seeds = [
            b"fundraiser",
            fundraiser.maker.as_ref(),
        ],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,

    /// Proves that this wallet contributed to this fundraiser.
    ///
    /// The account is writable because receipt_minted changes from
    /// false to true after the receipt is created successfully.
    #[account(
        mut,
        seeds = [
            b"contributor",
            fundraiser.key().as_ref(),
            contributor.key().as_ref(),
        ],
        bump,
    )]
    pub contributor_account: Account<'info, Contributor>,

    /// The unique zero-decimal receipt mint.
    ///
    /// `init_if_needed` allows a second request to reach our handler,
    /// where it receives the clear ReceiptAlreadyMinted error instead
    /// of failing earlier with a generic account-already-exists error.
    #[account(
        init_if_needed,
        payer = contributor,
        seeds = [
            b"receipt",
            fundraiser.key().as_ref(),
            contributor.key().as_ref(),
        ],
        bump,
        mint::decimals = 0,
        mint::authority = fundraiser,
        mint::freeze_authority = fundraiser,
    )]
    pub receipt_mint: Account<'info, Mint>,

    /// The contributor's token account that holds the receipt.
    ///
    /// Because the mint has zero decimals and we mint exactly one unit,
    /// this account holds one indivisible receipt token.
    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint = receipt_mint,
        associated_token::authority = contributor,
    )]
    pub receipt_ata: Account<'info, TokenAccount>,

    /// The SPL Token program creates, mints, and freezes the receipt.
    pub token_program: Program<'info, Token>,

    /// Creates the contributor's associated token account.
    pub associated_token_program: Program<'info, AssociatedToken>,

    /// Creates the receipt mint PDA and pays account rent.
    pub system_program: Program<'info, System>,
}

impl<'info> MintReceipt<'info> {
    /// Mints and freezes one receipt NFT for a valid contributor.
    pub fn mint_receipt(&mut self) -> Result<()> {
        // The contributor must have deposited at least one raw token unit.
        // This prevents wallets with no contribution from claiming receipts.
        require!(
            self.contributor_account.amount > 0,
            FundraiserError::NoContribution
        );

        // Every contributor may receive only one receipt for this fundraiser.
        //
        // This check occurs before the CPI, so duplicate attempts fail
        // without changing the mint or token account.
        require!(
            !self.contributor_account.receipt_minted,
            FundraiserError::ReceiptAlreadyMinted
        );

        // A receipt must be indivisible. Zero decimals means its only
        // possible whole-token values are 0, 1, 2, and so on.
        require!(
            self.receipt_mint.decimals == 0,
            FundraiserError::InvalidReceiptMint
        );

        // Recreate the fundraiser PDA signer seeds.
        //
        // These seeds must exactly match the fundraiser PDA definition:
        // ["fundraiser", maker, bump]
        let fundraiser_bump = [self.fundraiser.bump];

        let fundraiser_seeds: &[&[u8]] = &[
            b"fundraiser",
            self.fundraiser.maker.as_ref(),
            &fundraiser_bump,
        ];

        let signer_seeds: &[&[&[u8]]] = &[
            fundraiser_seeds,
        ];

        // Mint exactly one receipt token to the contributor.
        let mint_accounts = MintTo {
            mint: self.receipt_mint.to_account_info(),
            to: self.receipt_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let mint_context = CpiContext::new_with_signer(
            self.token_program.key(),
            mint_accounts,
            signer_seeds,
        );

        mint_to(mint_context, 1)?;

        // Freeze the receipt token account after minting.
        //
        // This makes the receipt non-transferable. A contributor cannot
        // sell it to another wallet or use one contribution to create
        // eligibility for several different wallets.
        let freeze_accounts = FreezeAccount {
            account: self.receipt_ata.to_account_info(),
            mint: self.receipt_mint.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let freeze_context = CpiContext::new_with_signer(
            self.token_program.key(),
            freeze_accounts,
            signer_seeds,
        );

        freeze_account(freeze_context)?;

        // Record the one-time action only after both CPIs succeed.
        //
        // Solana transactions are atomic: if minting or freezing fails,
        // every change from this instruction is rolled back.
        self.contributor_account.receipt_minted = true;

        Ok(())
    }
}