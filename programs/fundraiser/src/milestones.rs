use anchor_lang::prelude::*;

use crate::{MILESTONE_25, MILESTONE_50, MILESTONE_75, PERCENTAGE_SCALER};

pub const MILESTONES: [(u8, u8); 3] = [(25, MILESTONE_25), (50, MILESTONE_50), (75, MILESTONE_75)];

#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    pub percentage: u8,
    pub total_amount: u64,
}

/// Calculates `floor(amount * percentage / 100)` without multiplying the full
/// amount first. Splitting the calculation into quotient and remainder keeps it
/// valid for every `u64` amount while still using checked arithmetic.
pub fn percentage_of(amount: u64, percentage: u8) -> Option<u64> {
    let quotient = amount.checked_div(PERCENTAGE_SCALER)?;
    let remainder = amount.checked_rem(PERCENTAGE_SCALER)?;
    let percentage = u64::from(percentage);

    quotient.checked_mul(percentage)?.checked_add(
        remainder
            .checked_mul(percentage)?
            .checked_div(PERCENTAGE_SCALER)?,
    )
}

/// Returns the bits for milestones that are reached by `total_amount` and are
/// absent from the historical bitmask. Every milestone is evaluated so a
/// single update can cross more than one threshold.
pub fn newly_reached_milestones(
    amount_to_raise: u64,
    total_amount: u64,
    milestones_reached: u8,
) -> Option<u8> {
    let mut newly_reached = 0;

    for (percentage, bit) in MILESTONES {
        // Round up fractional thresholds so a milestone never fires early.
        let fractional = amount_to_raise
            .checked_rem(PERCENTAGE_SCALER)?
            .checked_mul(u64::from(percentage))?
            .checked_rem(PERCENTAGE_SCALER)?;
        let threshold =
            percentage_of(amount_to_raise, percentage)?.checked_add(u64::from(fractional != 0))?;
        if total_amount >= threshold && milestones_reached & bit == 0 {
            newly_reached |= bit;
        }
    }

    Some(newly_reached)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_percentages_without_overflow() {
        assert_eq!(
            percentage_of(u64::MAX, 75),
            Some(13_835_058_055_282_163_711)
        );
    }

    #[test]
    fn records_every_crossed_milestone() {
        assert_eq!(newly_reached_milestones(100, 80, 0), Some(0b111));
        assert_eq!(newly_reached_milestones(100, 80, 0b001), Some(0b110));
        assert_eq!(newly_reached_milestones(100, 80, 0b111), Some(0));
    }

    #[test]
    fn exact_threshold_is_reached() {
        for (percentage, bit) in MILESTONES {
            let threshold = u64::from(percentage);
            let history = bit - 1;
            assert_eq!(
                newly_reached_milestones(100, threshold - 1, history),
                Some(0)
            );
            assert_eq!(newly_reached_milestones(100, threshold, history), Some(bit));
        }
    }

    #[test]
    fn awkward_target_does_not_reach_milestones_early() {
        for (threshold, bit) in [(26, MILESTONE_25), (51, MILESTONE_50), (76, MILESTONE_75)] {
            let history = bit - 1;
            assert_eq!(
                newly_reached_milestones(101, threshold - 1, history),
                Some(0)
            );
            assert_eq!(newly_reached_milestones(101, threshold, history), Some(bit));
        }
    }

    #[test]
    fn rounds_up_maximum_target_without_overflow() {
        for (threshold, bit) in [
            (4_611_686_018_427_387_904, MILESTONE_25),
            (9_223_372_036_854_775_808, MILESTONE_50),
            (13_835_058_055_282_163_712, MILESTONE_75),
        ] {
            let history = bit - 1;
            assert_eq!(
                newly_reached_milestones(u64::MAX, threshold - 1, history),
                Some(0)
            );
            assert_eq!(
                newly_reached_milestones(u64::MAX, threshold, history),
                Some(bit)
            );
        }
    }
}
