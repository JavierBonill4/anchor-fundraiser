use anchor_lang::prelude::*;
use anchor_lang::system_program::{create_account, CreateAccount};
use anchor_spl::associated_token::{create as create_ata, get_associated_token_address, AssociatedToken, Create as CreateAta};
use anchor_spl::token::{
    initialize_mint2,
    mint_to,
    set_authority,
    spl_token::instruction::AuthorityType,
    InitializeMint2,
    Mint,
    MintTo,
    SetAuthority,
    transfer,
    Token,
    TokenAccount,
    Transfer
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
    // One 0-decimal mint per (fundraiser, contributor) pair — the NFT receipt.
    /// CHECK: created and initialized by hand in the handler, only on this
    /// contributor's first contribution. Deliberately NOT `Account<'info,
    /// Mint>` with `init_if_needed` + `mint::authority = fundraiser`: that
    /// sugar re-validates the mint's *current* authority on every call, and
    /// this program revokes that authority right after minting — so every
    /// contribution after the first would fail account validation here,
    /// before the handler's `has_receipt` guard ever ran. The `seeds`/`bump`
    /// check below is still safe to leave in Anchor's hands: a PDA's address
    /// never changes, only its authority does.
    #[account(
        mut,
        seeds = [b"receipt", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
    )]
    pub receipt_mint: UncheckedAccount<'info>,
    /// CHECK: the contributor's associated token account for `receipt_mint`.
    /// Same reasoning — created by hand in the handler in step with the
    /// mint. Its address is checked against the standard ATA derivation
    /// inside the handler before it's used for anything.
    #[account(mut)]
    pub contributor_receipt_ata: UncheckedAccount<'info>,
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

        // Mint the one-time NFT receipt, only on this contributor's first
        // contribution to this fundraiser. `has_receipt` starts false because
        // account data is zero-initialized on creation, same as `amount`.
        if !self.contributor_account.has_receipt {
            let fundraiser_signer_seeds: [&[&[u8]]; 1] = [&[
                b"fundraiser".as_ref(),
                self.fundraiser.maker.as_ref(),
                &[self.fundraiser.bump],
            ]];

            // 1. Create the receipt mint account at its own PDA address. It
            //    signs for its own creation, the same trick the fundraiser
            //    PDA uses for itself in `initialize`.
            let receipt_bump_bytes = [bumps.receipt_mint];
            let fundraiser_key = self.fundraiser.key();
            let contributor_key = self.contributor.key();
            let receipt_signer_seeds: [&[&[u8]]; 1] = [&[
                b"receipt".as_ref(),
                fundraiser_key.as_ref(),
                contributor_key.as_ref(),
                &receipt_bump_bytes,
            ]];

            let mint_space = Mint::LEN as u64;
            let mint_rent = Rent::get()?.minimum_balance(mint_space as usize);

            create_account(
                CpiContext::new_with_signer(
                    self.system_program.key(),
                    CreateAccount {
                        from: self.contributor.to_account_info(),
                        to: self.receipt_mint.to_account_info(),
                    },
                    &receipt_signer_seeds,
                ),
                mint_rent,
                mint_space,
                &self.token_program.key(),
            )?;

            // 2. Initialize it as a 0-decimal mint. Authority starts as the
            //    fundraiser PDA so step 4 below can revoke it.
            initialize_mint2(
                CpiContext::new(
                    self.token_program.key(),
                    InitializeMint2 {
                        mint: self.receipt_mint.to_account_info(),
                    },
                ),
                0,
                &self.fundraiser.key(),
                None,
            )?;

            // 3. Create the contributor's associated token account for it,
            //    after checking they actually passed the real ATA address —
            //    since Anchor isn't validating this account for us anymore.
            let expected_ata =
                get_associated_token_address(&self.contributor.key(), &self.receipt_mint.key());
            require_keys_eq!(
                self.contributor_receipt_ata.key(),
                expected_ata,
                FundraiserError::InvalidReceiptAta
            );

            create_ata(CpiContext::new(
                self.associated_token_program.key(),
                CreateAta {
                    payer: self.contributor.to_account_info(),
                    associated_token: self.contributor_receipt_ata.to_account_info(),
                    authority: self.contributor.to_account_info(),
                    mint: self.receipt_mint.to_account_info(),
                    system_program: self.system_program.to_account_info(),
                    token_program: self.token_program.to_account_info(),
                },
            ))?;

            let cpi_program = self.token_program.key();

            // 4. Mint the single receipt token to the contributor.
            let mint_cpi_accounts = MintTo {
                mint: self.receipt_mint.to_account_info(),
                to: self.contributor_receipt_ata.to_account_info(),
                authority: self.fundraiser.to_account_info(),
            };
            let mint_cpi_ctx =
                CpiContext::new_with_signer(cpi_program, mint_cpi_accounts, &fundraiser_signer_seeds);
            mint_to(mint_cpi_ctx, 1)?;

            // 5. Fix the supply at 1 forever by revoking the mint authority.
            let revoke_cpi_accounts = SetAuthority {
                current_authority: self.fundraiser.to_account_info(),
                account_or_mint: self.receipt_mint.to_account_info(),
            };
            let revoke_cpi_ctx =
                CpiContext::new_with_signer(cpi_program, revoke_cpi_accounts, &fundraiser_signer_seeds);
            set_authority(revoke_cpi_ctx, AuthorityType::MintTokens, None)?;

            self.contributor_account.has_receipt = true;
        }

        Ok(())
    }
}