use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{transfer, Mint, Token, TokenAccount, Transfer},
};

use crate::{
    error::FundraiserError,
    state::{Contributor, Success},
};

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,

    /// The persistent proof that the fundraiser successfully completed.
    #[account(
        mut,
        seeds = [b"success", fundraiser.key().as_ref()],
        bump = success.bump,
    )]
    pub success: Account<'info, Success>,

    /// The fundraiser PDA was closed after a successful campaign.
    /// We only need its address so it can act as the authority of the
    /// reward vault and as the PDA signer for the token transfer.
    ///
    /// CHECK: The address is explicitly validated against
    /// [b"fundraiser", success.maker] and success.fundraiser_bump
    /// inside claim_reward().
    pub fundraiser: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [
            b"contributor",
            success.fundraiser.as_ref(),
            contributor.key().as_ref(),
        ],
        bump,
    )]
    pub contributor_account: Account<'info, Contributor>,

    #[account(
        address = success.reward_mint,
    )]
    pub reward_mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = reward_mint,
        associated_token::authority = fundraiser,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = contributor,
        associated_token::mint = reward_mint,
        associated_token::authority = contributor,
    )]
    pub contributor_reward_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

impl<'info> ClaimReward<'info> {
    pub fn claim_reward(&mut self) -> Result<()> {
        // -----------------------------------------------------------------
        // 1. Verify that the supplied fundraiser account is the original
        //    fundraiser PDA.
        //
        // Original fundraiser seeds:
        // [b"fundraiser", maker]
        // -----------------------------------------------------------------

        let expected_fundraiser = Pubkey::create_program_address(
            &[
                b"fundraiser",
                self.success.maker.as_ref(),
                &[self.success.fundraiser_bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(FundraiserError::InvalidAmount))?;

        require!(
            self.fundraiser.key() == expected_fundraiser,
            FundraiserError::InvalidAmount
        );

        // -----------------------------------------------------------------
        // 2. Verify that Success belongs to this fundraiser.
        // -----------------------------------------------------------------

        require!(
            self.success.fundraiser == self.fundraiser.key(),
            FundraiserError::InvalidAmount
        );

        // -----------------------------------------------------------------
        // 3. Verify that the Success account itself is the expected
        //    Success PDA.
        //
        // Success seeds:
        // [b"success", fundraiser]
        // -----------------------------------------------------------------

        let expected_success = Pubkey::create_program_address(
            &[
                b"success",
                self.fundraiser.key().as_ref(),
                &[self.success.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(FundraiserError::InvalidAmount))?;

        require!(
            self.success.key() == expected_success,
            FundraiserError::InvalidAmount
        );

        // -----------------------------------------------------------------
        // 4. Make sure the contributor has not already claimed.
        // -----------------------------------------------------------------

        require!(
            !self.contributor_account.reward_claimed,
            FundraiserError::RewardAlreadyClaimed
        );

        // -----------------------------------------------------------------
        // 5. A contributor must have actually contributed.
        // -----------------------------------------------------------------

        require!(
            self.contributor_account.amount > 0,
            FundraiserError::NoContribution
        );

        // -----------------------------------------------------------------
        // 6. The contributor's reward is derived from their recorded
        //    contribution.
        //
        // Current reward model:
        //
        // contribution amount == reward amount
        // -----------------------------------------------------------------

        let reward_amount = self.contributor_account.amount;

        // -----------------------------------------------------------------
        // 7. Transfer the reward tokens from the fundraiser-controlled
        //    reward vault to the contributor's reward ATA.
        //
        // The fundraiser PDA is the authority of reward_vault, so it
        // must sign the CPI.
        // -----------------------------------------------------------------

        let maker_key = self.success.maker;

        let signer_seeds: &[&[&[u8]]] = &[&[
            b"fundraiser",
            maker_key.as_ref(),
            &[self.success.fundraiser_bump],
        ]];

        let cpi_accounts = Transfer {
            from: self.reward_vault.to_account_info(),
            to: self.contributor_reward_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let cpi_ctx =
            CpiContext::new_with_signer(self.token_program.key(), cpi_accounts, signer_seeds);

        transfer(cpi_ctx, reward_amount)?;

        // -----------------------------------------------------------------
        // 8. Mark the contributor's reward as claimed.
        //
        // This prevents a second successful claim.
        // -----------------------------------------------------------------

        self.contributor_account.reward_claimed = true;

        Ok(())
    }
}
