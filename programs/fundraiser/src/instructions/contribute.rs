use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};

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
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

fn milestone_mask_for_amount(current_amount: u64, target_amount: u64) -> Result<u8> {
    if target_amount == 0 {
        return Ok(0);
    }

    let quarters = current_amount
        .checked_mul(4)
        .ok_or(FundraiserError::Overflow)?
        / target_amount;

    let mut mask = 0u8;
    for i in 0..quarters.min(3) {
        mask |= 1u8 << i;
    }

    Ok(mask)
}

#[cfg(test)]
mod tests {
    use super::milestone_mask_for_amount;

    #[test]
    fn fires_all_newly_reached_milestones() {
        let target = 30_000_000u64;

        assert_eq!(
            milestone_mask_for_amount(7_500_000, target).unwrap(),
            1u8 << 0
        );
        assert_eq!(
            milestone_mask_for_amount(15_000_000, target).unwrap(),
            (1u8 << 0) | (1u8 << 1)
        );
        assert_eq!(
            milestone_mask_for_amount(22_500_000, target).unwrap(),
            (1u8 << 0) | (1u8 << 1) | (1u8 << 2)
        );
    }

    #[test]
    fn only_marks_newly_reached_thresholds() {
        let target = 30_000_000u64;
        let current = 22_500_000u64;

        let reached = milestone_mask_for_amount(current, target).unwrap();
        let existing = (1u8 << 0) | (1u8 << 1);
        let newly_reached = reached & !existing;

        assert_eq!(reached, 0b111);
        assert_eq!(newly_reached, 1u8 << 2);
    }

    #[test]
    fn does_not_replay_old_milestones() {
        let target = 30_000_000u64;
        let already_set = 0b011u8;
        let reached = milestone_mask_for_amount(22_500_000, target).unwrap();
        let newly_reached = reached & !already_set;

        assert_eq!(reached, 0b111);
        assert_eq!(newly_reached, 0b100);
    }
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

        // Update the fundraiser and contributor accounts with the new amounts.
        // The milestone bitmask is a one-way flag set inline at the end of the
        // instruction, after the vault and totals have moved.
        let new_total = self
            .fundraiser
            .current_amount
            .checked_add(amount)
            .ok_or(FundraiserError::Overflow)?;

        self.fundraiser.current_amount = new_total;
        self.contributor_account.amount += amount;

        let new_milestones = milestone_mask_for_amount(
            self.fundraiser.current_amount,
            self.fundraiser.amount_to_raise,
        )? & !self.fundraiser.milestones_fired;
        self.fundraiser.milestones_fired |= new_milestones;

        Ok(())
    }
}
