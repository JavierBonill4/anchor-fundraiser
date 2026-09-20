use anchor_lang::{prelude::*, system_program};
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    metadata::{
        create_master_edition_v3, create_metadata_accounts_v3, mpl_token_metadata::types::DataV2,
        CreateMasterEditionV3, CreateMetadataAccountsV3, Metadata,
    },
    token::{initialize_mint2, mint_to, InitializeMint2, Mint, MintTo, Token},
};

use crate::{
    state::Contributor, FundraiserError, EARLY_INVESTOR_NFT_NAME, EARLY_INVESTOR_NFT_SYMBOL,
    EARLY_INVESTOR_NFT_URI,
};

#[derive(Accounts)]
pub struct ClaimEarlyInvestorNft<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,
    /// CHECK: The contributor PDA seeds bind this address to the claim.
    pub fundraiser: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        constraint = contributor_account.is_early_investor @ FundraiserError::NotEarlyInvestor,
        constraint = !contributor_account.nft_claimed @ FundraiserError::NftAlreadyClaimed,
    )]
    pub contributor_account: Account<'info, Contributor>,
    /// CHECK: Seeds derive the CPI signing authority; no account data is read.
    #[account(seeds = [b"early-investor-authority", fundraiser.key().as_ref()], bump)]
    pub nft_authority: UncheckedAccount<'info>,
    /// CHECK: The handler creates and initializes this seeds-validated mint.
    #[account(mut, seeds = [b"early-investor-mint", fundraiser.key().as_ref(), contributor.key().as_ref()], bump)]
    pub nft_mint: UncheckedAccount<'info>,
    /// CHECK: The associated-token program validates and creates this ATA.
    #[account(mut)]
    pub nft_token_account: UncheckedAccount<'info>,
    /// CHECK: validated by the metadata program against `["metadata", program_id, mint]`.
    #[account(
        mut,
        seeds = [b"metadata", token_metadata_program.key().as_ref(), nft_mint.key().as_ref()],
        bump,
        seeds::program = token_metadata_program.key(),
    )]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: validated by the metadata program against `["metadata", program_id, mint, "edition"]`.
    #[account(
        mut,
        seeds = [b"metadata", token_metadata_program.key().as_ref(), nft_mint.key().as_ref(), b"edition"],
        bump,
        seeds::program = token_metadata_program.key(),
    )]
    pub master_edition: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

impl<'info> ClaimEarlyInvestorNft<'info> {
    pub fn claim_early_investor_nft(&mut self, bumps: &ClaimEarlyInvestorNftBumps) -> Result<()> {
        self.contributor_account.nft_claimed = true;

        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"early-investor-authority".as_ref(),
            self.fundraiser.to_account_info().key.as_ref(),
            &[bumps.nft_authority],
        ]];

        let mint_signer_seeds: [&[&[u8]]; 1] = [&[
            b"early-investor-mint".as_ref(),
            self.fundraiser.to_account_info().key.as_ref(),
            self.contributor.to_account_info().key.as_ref(),
            &[bumps.nft_mint],
        ]];

        system_program::create_account(
            CpiContext::new_with_signer(
                self.system_program.key(),
                system_program::CreateAccount {
                    from: self.contributor.to_account_info(),
                    to: self.nft_mint.to_account_info(),
                },
                &mint_signer_seeds,
            ),
            Rent::get()?.minimum_balance(Mint::LEN),
            Mint::LEN as u64,
            &self.token_program.key(),
        )?;

        initialize_mint2(
            CpiContext::new(
                self.token_program.key(),
                InitializeMint2 {
                    mint: self.nft_mint.to_account_info(),
                },
            ),
            0,
            &self.nft_authority.key(),
            Some(&self.nft_authority.key()),
        )?;

        associated_token::create(CpiContext::new(
            self.associated_token_program.key(),
            associated_token::Create {
                payer: self.contributor.to_account_info(),
                associated_token: self.nft_token_account.to_account_info(),
                authority: self.contributor.to_account_info(),
                mint: self.nft_mint.to_account_info(),
                system_program: self.system_program.to_account_info(),
                token_program: self.token_program.to_account_info(),
            },
        ))?;

        mint_to(
            CpiContext::new_with_signer(
                self.token_program.key(),
                MintTo {
                    mint: self.nft_mint.to_account_info(),
                    to: self.nft_token_account.to_account_info(),
                    authority: self.nft_authority.to_account_info(),
                },
                &signer_seeds,
            ),
            1,
        )?;

        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                self.token_metadata_program.key(),
                CreateMetadataAccountsV3 {
                    metadata: self.metadata.to_account_info(),
                    mint: self.nft_mint.to_account_info(),
                    mint_authority: self.nft_authority.to_account_info(),
                    update_authority: self.nft_authority.to_account_info(),
                    payer: self.contributor.to_account_info(),
                    system_program: self.system_program.to_account_info(),
                    rent: self.rent.to_account_info(),
                },
                &signer_seeds,
            ),
            DataV2 {
                name: EARLY_INVESTOR_NFT_NAME.to_string(),
                symbol: EARLY_INVESTOR_NFT_SYMBOL.to_string(),
                uri: EARLY_INVESTOR_NFT_URI.to_string(),
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            false,
            true,
            None,
        )?;

        create_master_edition_v3(
            CpiContext::new_with_signer(
                self.token_metadata_program.key(),
                CreateMasterEditionV3 {
                    edition: self.master_edition.to_account_info(),
                    mint: self.nft_mint.to_account_info(),
                    update_authority: self.nft_authority.to_account_info(),
                    mint_authority: self.nft_authority.to_account_info(),
                    payer: self.contributor.to_account_info(),
                    metadata: self.metadata.to_account_info(),
                    token_program: self.token_program.to_account_info(),
                    system_program: self.system_program.to_account_info(),
                    rent: self.rent.to_account_info(),
                },
                &signer_seeds,
            ),
            Some(0),
        )?;

        Ok(())
    }
}
