use anchor_lang::prelude::*;

use crate::{MILESTONE_COUNT, MILESTONE_DENOMINATOR};

#[account]
#[derive(InitSpace)]
pub struct Fundraiser {
    pub maker: Pubkey,
    pub mint_to_raise: Pubkey,
    pub amount_to_raise: u64,
    pub current_amount: u64,
    pub time_started: i64,
    pub duration: u8,
    pub bump: u8,
    /// Which quarter marks have fired, as a bitmask.
    /// bit 0 = 25%, bit 1 = 50%, bit 2 = 75%.
    /// Appended last so the offset of every field above it is unchanged.
    pub milestones_fired: u8,
}

impl Fundraiser {
    /// Bitmask of every milestone the vault satisfies right now, fired or not.
    ///
    /// Milestone `k` (0-based) is satisfied when
    /// `current_amount / amount_to_raise >= (k + 1) / 4`. The comparison is
    /// cross-multiplied in u128, so there is no division, no rounding and no
    /// overflow path.
    pub fn milestones_reached(&self) -> u8 {
        let current = self.current_amount as u128;
        let target = self.amount_to_raise as u128;
        let denominator = MILESTONE_DENOMINATOR as u128;

        let mut mask = 0u8;
        for k in 0..MILESTONE_COUNT {
            let numerator = (k as u128) + 1;
            if current * denominator >= target * numerator {
                mask |= 1u8 << k;
            }
        }
        mask
    }

    /// Milestones that are satisfied now but have not fired yet.
    ///
    /// A single contribution can jump past a mark without ever landing on it,
    /// so the question is never "did this deposit hit 25%" but "which marks
    /// are satisfied and still unfired".
    pub fn milestones_pending(&self) -> u8 {
        self.milestones_reached() & !self.milestones_fired
    }
}
