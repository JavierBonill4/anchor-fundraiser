use anchor_lang::prelude::*;
use anchor_spl::token::{
    transfer,
    Mint,
    Token,
    TokenAccount,
    Transfer,
};

use crate::{
    state::{
        Contributor,
        Fundraiser,
    },
    FundraiserError,
    ANCHOR_DISCRIMINATOR,
    MAX_CONTRIBUTION_PERCENTAGE,
    PERCENTAGE_SCALER,
    SECONDS_TO_DAYS,
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
        seeds = [
            b"contributor",
            fundraiser.key().as_ref(),
            contributor.key().as_ref()
        ],
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

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}


/// Emitted whenever the fundraiser crosses a new milestone.
///
/// milestone:
///     25 = 25%
///     50 = 50%
///     75 = 75%
#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    pub milestone: u8,
    pub amount: u64,
}


impl<'info> Contribute<'info> {
    pub fn contribute(&mut self, amount: u64) -> Result<()> {

        // ------------------------------------------------------------
        // 1. Check minimum contribution
        // ------------------------------------------------------------

        // Convert one whole token into its smallest unit.
        let one_token = 10u64
            .checked_pow(self.mint_to_raise.decimals as u32)
            .ok_or(FundraiserError::ContributionTooSmall)?;

        require!(
            amount >= one_token,
            FundraiserError::ContributionTooSmall
        );


        // ------------------------------------------------------------
        // 2. Check maximum contribution
        // ------------------------------------------------------------

        let maximum_contribution = self
            .fundraiser
            .amount_to_raise
            .checked_mul(MAX_CONTRIBUTION_PERCENTAGE)
            .ok_or(FundraiserError::Overflow)?
            / PERCENTAGE_SCALER;

        require!(
            amount <= maximum_contribution,
            FundraiserError::ContributionTooBig
        );


        // ------------------------------------------------------------
        // 3. Check fundraiser duration
        // ------------------------------------------------------------

        let current_time = Clock::get()?.unix_timestamp;

        require!(
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                < self.fundraiser.duration as i64,
            FundraiserError::FundraiserEnded
        );


        // ------------------------------------------------------------
        // 4. Check contributor's maximum contribution
        // ------------------------------------------------------------

        let contributor_new_amount = self
            .contributor_account
            .amount
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;

        require!(
            self.contributor_account.amount <= maximum_contribution
                && contributor_new_amount <= maximum_contribution,
            FundraiserError::MaximumContributionsReached
        );


        // ------------------------------------------------------------
        // 5. Transfer tokens into fundraiser vault
        // ------------------------------------------------------------

        let cpi_accounts = Transfer {
            from: self.contributor_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.contributor.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(
            self.token_program.key(),
            cpi_accounts,
        );

        transfer(cpi_ctx, amount)?;


        // ------------------------------------------------------------
        // 6. Update fundraiser amount
        // ------------------------------------------------------------

        self.fundraiser.current_amount = self
            .fundraiser
            .current_amount
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;


        // ------------------------------------------------------------
        // 7. Update contributor amount
        // ------------------------------------------------------------

        self.contributor_account.amount = contributor_new_amount;


        // ------------------------------------------------------------
        // 8. Check milestones
        // ------------------------------------------------------------
        //
        // Bit 0 -> 25%
        // Bit 1 -> 50%
        // Bit 2 -> 75%
        //
        // We calculate:
        //
        // current_amount * 4 / target
        //
        // Example:
        //
        // current = 25%
        // 25 * 4 / 100 = 1
        //
        // current = 50%
        // 50 * 4 / 100 = 2
        //
        // current = 80%
        // 80 * 4 / 100 = 3
        //
        // This also handles a contribution that jumps over
        // multiple milestones in a single transaction.

        let quarters = self
            .fundraiser
            .current_amount
            .checked_mul(4)
            .ok_or(FundraiserError::Overflow)?
            / self.fundraiser.amount_to_raise;


        // Only three milestones exist: 25%, 50%, 75%.
        for i in 0..quarters.min(3) {

            // Convert milestone index into bit flag.
            //
            // i = 0 -> 00000001 -> 25%
            // i = 1 -> 00000010 -> 50%
            // i = 2 -> 00000100 -> 75%
            let flag = 1u8 << (i as u32);


            // --------------------------------------------------------
            // Check whether this milestone was already fired
            // --------------------------------------------------------

            if self.fundraiser.milestones_fired & flag == 0 {

                // Mark milestone as fired BEFORE emitting event.
                //
                // This makes the milestone one-way and prevents
                // the same milestone from being triggered again.
                self.fundraiser.milestones_fired |= flag;


                // Convert:
                //
                // i = 0 -> 25
                // i = 1 -> 50
                // i = 2 -> 75
                let milestone = ((i + 1) * 25) as u8;


                // ----------------------------------------------------
                // Emit milestone event
                // ----------------------------------------------------

                emit!(MilestoneReached {
                    fundraiser: self.fundraiser.key(),
                    milestone,
                    amount: self.fundraiser.current_amount,
                });
            }
        }


        Ok(())
    }
}