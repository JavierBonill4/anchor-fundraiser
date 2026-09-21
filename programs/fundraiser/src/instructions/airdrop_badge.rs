use anchor_lang::{
    prelude::*,
    solana_program::{program::invoke_signed, system_instruction},
};
use anchor_spl::{
    associated_token::{
        create as create_ata, get_associated_token_address_with_program_id, AssociatedToken, Create,
    },
    token_2022::{
        initialize_mint2, mint_to, spl_token_2022::extension::ExtensionType, InitializeMint2,
        MintTo, Token2022,
    },
    token_2022_extensions::{
        metadata_pointer_initialize, non_transferable_mint_initialize,
        spl_token_metadata_interface::state::TokenMetadata, token_metadata_initialize,
        MetadataPointerInitialize, NonTransferableMintInitialize, TokenMetadataInitialize,
    },
};

use crate::{
    state::{Contributor, Fundraiser},
    BadgeAirdropped, FundraiserError, BADGE_NAME, BADGE_SEED, BADGE_SYMBOL, MAX_URI_LEN,
};

#[derive(Accounts)]
pub struct AirdropBadge<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Wallet that donated. Does not sign — this is a crank.
    pub contributor: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [b"fundraiser", fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
    #[account(
        mut,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump = contributor_account.bump,
    )]
    pub contributor_account: Account<'info, Contributor>,
    /// CHECK: we create this as a Token-2022 mint in the handler.
    #[account(
        mut,
        seeds = [BADGE_SEED, fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
    )]
    pub badge_mint: UncheckedAccount<'info>,
    /// CHECK: Token-2022 ATA, created after the mint exists.
    #[account(mut)]
    pub badge_ata: UncheckedAccount<'info>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> AirdropBadge<'info> {
    pub fn airdrop_badge(&mut self, uri: String, bumps: &AirdropBadgeBumps) -> Result<()> {
        require!(
            self.fundraiser.is_claimed,
            FundraiserError::CampaignNotClaimed
        );
        require!(
            !self.contributor_account.badge_minted,
            FundraiserError::BadgeAlreadyMinted
        );
        require!(
            !uri.is_empty() && uri.len() <= MAX_URI_LEN,
            FundraiserError::InvalidUri
        );
        require!(
            self.badge_mint.data_is_empty(),
            FundraiserError::BadgeAlreadyMinted
        );
        require_keys_eq!(
            self.payer.key(),
            self.fundraiser.minter,
            FundraiserError::UnauthorizeMinter
        );
        let expected_ata = get_associated_token_address_with_program_id(
            &self.contributor.key(),
            &self.badge_mint.key(),
            &self.token_2022_program.key(),
        );
        require_keys_eq!(self.badge_ata.key(), expected_ata);

        // Create with NonTransferable + MetadataPointer only. TokenMetadata is a
        // variable-len TLV written after InitializeMint2; pre-sizing for it makes
        // InitializeMint2 reject the account (InvalidAccountData). Pay rent for the
        // final size so token_metadata_initialize can realloc.
        let space = badge_mint_base_len()?;
        let extra = badge_metadata_tlv_len(&uri, self.badge_mint.key(), self.fundraiser.key())?;
        let lamports = Rent::get()?.minimum_balance(
            space
                .checked_add(extra)
                .ok_or(FundraiserError::InvalidUri)?,
        );
        let fundraiser_key = self.fundraiser.key();
        let contributor_key = self.contributor.key();
        let mint_seeds: &[&[u8]] = &[
            BADGE_SEED,
            fundraiser_key.as_ref(),
            contributor_key.as_ref(),
            &[bumps.badge_mint],
        ];

        invoke_signed(
            &system_instruction::create_account(
                &self.payer.key(),
                &self.badge_mint.key(),
                lamports,
                space as u64,
                &self.token_2022_program.key(),
            ),
            &[
                self.payer.to_account_info(),
                self.badge_mint.to_account_info(),
                self.system_program.to_account_info(),
            ],
            &[mint_seeds],
        )?;

        let token_program = self.token_2022_program.key();

        non_transferable_mint_initialize(CpiContext::new(
            token_program,
            NonTransferableMintInitialize {
                token_program_id: self.token_2022_program.to_account_info(),
                mint: self.badge_mint.to_account_info(),
            },
        ))?;

        metadata_pointer_initialize(
            CpiContext::new(
                token_program,
                MetadataPointerInitialize {
                    token_program_id: self.token_2022_program.to_account_info(),
                    mint: self.badge_mint.to_account_info(),
                },
            ),
            Some(self.fundraiser.key()),
            Some(self.badge_mint.key()),
        )?;

        initialize_mint2(
            CpiContext::new(
                token_program,
                InitializeMint2 {
                    mint: self.badge_mint.to_account_info(),
                },
            ),
            0,
            &self.fundraiser.key(),
            None,
        )?;

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"fundraiser",
            self.fundraiser.maker.as_ref(),
            &[self.fundraiser.bump],
        ]];

        token_metadata_initialize(
            CpiContext::new_with_signer(
                token_program,
                TokenMetadataInitialize {
                    program_id: self.token_2022_program.to_account_info(),
                    metadata: self.badge_mint.to_account_info(),
                    update_authority: self.fundraiser.to_account_info(),
                    mint_authority: self.fundraiser.to_account_info(),
                    mint: self.badge_mint.to_account_info(),
                },
                signer_seeds,
            ),
            BADGE_NAME.to_string(),
            BADGE_SYMBOL.to_string(),
            uri.clone(),
        )?;

        create_ata(CpiContext::new(
            self.associated_token_program.key(),
            Create {
                payer: self.payer.to_account_info(),
                associated_token: self.badge_ata.to_account_info(),
                authority: self.contributor.to_account_info(),
                mint: self.badge_mint.to_account_info(),
                system_program: self.system_program.to_account_info(),
                token_program: self.token_2022_program.to_account_info(),
            },
        ))?;

        mint_to(
            CpiContext::new_with_signer(
                token_program,
                MintTo {
                    mint: self.badge_mint.to_account_info(),
                    to: self.badge_ata.to_account_info(),
                    authority: self.fundraiser.to_account_info(),
                },
                signer_seeds,
            ),
            1,
        )?;

        self.contributor_account.badge_minted = true;
        self.fundraiser.badges_minted = self
            .fundraiser
            .badges_minted
            .checked_add(1)
            .ok_or(FundraiserError::TooManyCollaborations)?;

        emit!(BadgeAirdropped {
            fundraiser: self.fundraiser.key(),
            contributor: self.contributor.key(),
            badge_mint: self.badge_mint.key(),
            uri,
        });

        Ok(())
    }
}

fn badge_mint_base_len() -> Result<usize> {
    ExtensionType::try_calculate_account_len::<
        anchor_spl::token_2022::spl_token_2022::state::Mint,
    >(&[
        ExtensionType::NonTransferable,
        ExtensionType::MetadataPointer,
    ])
    .map_err(|_| error!(FundraiserError::InvalidUri))
}

fn badge_metadata_tlv_len(uri: &str, mint: Pubkey, update_authority: Pubkey) -> Result<usize> {
    let metadata = TokenMetadata {
        name: BADGE_NAME.to_string(),
        symbol: BADGE_SYMBOL.to_string(),
        uri: uri.to_string(),
        mint,
        update_authority: Some(update_authority)
            .try_into()
            .map_err(|_| error!(FundraiserError::InvalidUri))?,
        additional_metadata: vec![],
    };
    metadata
        .tlv_size_of()
        .map_err(|_| error!(FundraiserError::InvalidUri))
}
