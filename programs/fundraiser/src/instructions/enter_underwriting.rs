use anchor_lang::prelude::*;

use crate::{
    state::{Fundraiser, FundraiserState},
    FundraiserError, SECONDS_TO_DAYS, UNDERWRITING_DURATION_DAYS,
};

/// Permissionless instruction that anyone can call to transition a fundraiser
/// from Active to Underwriting after the deadline has passed and the target
/// was not met.
///
/// This is a crank: nobody in particular owns it, but someone must call it
/// to open the underwriting phase. The caller gets no reward — they are
/// doing the ecosystem a favor by advancing the state machine.
#[derive(Accounts)]
pub struct EnterUnderwriting<'info> {
    #[account(
        mut,
        seeds = [b"fundraiser", fundraiser.maker.as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
}

impl<'info> EnterUnderwriting<'info> {
    pub fn enter_underwriting(&mut self) -> Result<()> {
        // Must still be in Active state
        require!(
            self.fundraiser.state == FundraiserState::Active,
            FundraiserError::NotInUnderwritingPhase
        );

        let current_time = Clock::get()?.unix_timestamp;

        // Deadline must have passed
        let deadline_passed =
            (current_time - self.fundraiser.time_started) / SECONDS_TO_DAYS
                >= self.fundraiser.duration as i64;
        require!(deadline_passed, FundraiserError::FundraiserNotEnded);

        // Target must NOT have been met (otherwise it's a success, not underwriting)
        // We use the vault amount indirectly: current_amount tracks deposits.
        // The vault should hold exactly current_amount tokens at this point.
        require!(
            self.fundraiser.current_amount < self.fundraiser.amount_to_raise,
            FundraiserError::TargetMet
        );

        // Calculate shortfall using checked arithmetic
        let shortfall = self
            .fundraiser
            .amount_to_raise
            .checked_sub(self.fundraiser.current_amount)
            .ok_or(FundraiserError::Overflow)?;

        require!(shortfall > 0, FundraiserError::NoShortfall);

        // Set state to Underwriting
        self.fundraiser.state = FundraiserState::Underwriting;
        self.fundraiser.original_shortfall = shortfall;
        self.fundraiser.total_underwritten = 0;
        self.fundraiser.total_outstanding_claims = 0;
        self.fundraiser.underwriting_deadline =
            current_time + UNDERWRITING_DURATION_DAYS * SECONDS_TO_DAYS;

        Ok(())
    }
}
