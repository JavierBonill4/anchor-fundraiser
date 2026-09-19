use anchor_lang::prelude::*;

use crate::{state::Fundraiser, FundraiserError, MILESTONE_PERCENTS, PERCENTAGE_SCALER};

/// Emitted by `contribute` for every mark the campaign crosses, including the
/// marks a single large contribution jumps straight past.
#[event]
pub struct MilestoneReached {
    pub fundraiser: Pubkey,
    pub index: u8,
    pub percent: u64,
    pub current_amount: u64,
    pub amount_to_raise: u64,
}

/// Emitted by `acknowledge_milestone`, at most once per index.
#[event]
pub struct MilestoneAnnounced {
    pub fundraiser: Pubkey,
    pub index: u8,
    pub percent: u64,
}

/// Records every milestone the campaign has now touched and emits one event per
/// newly crossed mark.
///
/// The loop is the whole point: a contribution is allowed to be up to 10% of the
/// target, and a refund followed by a fresh contribution can move the total in
/// jumps, so "one mark per contribution" is wrong. Every unset bit is retested
/// on every call, and bits latch — a later refund lowers `current_amount`, but a
/// mark that was genuinely reached stays reached.
///
/// The comparison is `raised * 100 >= percent * target` in u128, so there is no
/// division, no rounding and no float anywhere on the path.
pub fn record_milestones(fundraiser: &mut Account<Fundraiser>) -> Result<()> {
    let key = fundraiser.key();
    let raised = fundraiser.current_amount as u128;
    let target = fundraiser.amount_to_raise as u128;

    let scaled_raised = raised
        .checked_mul(PERCENTAGE_SCALER as u128)
        .ok_or(FundraiserError::InvalidAmount)?;

    for (index, percent) in MILESTONE_PERCENTS.iter().enumerate() {
        let bit = 1u8 << index;
        if fundraiser.milestones_reached & bit != 0 {
            continue;
        }

        let threshold = target
            .checked_mul(*percent as u128)
            .ok_or(FundraiserError::InvalidAmount)?;

        if scaled_raised >= threshold {
            fundraiser.milestones_reached |= bit;
            emit!(MilestoneReached {
                fundraiser: key,
                index: index as u8,
                percent: *percent,
                current_amount: fundraiser.current_amount,
                amount_to_raise: fundraiser.amount_to_raise,
            });
        }
    }

    Ok(())
}

/// The maker acknowledges one reached milestone. Announcing is the thing that
/// must not fire twice, so it is guarded by its own flag byte rather than by the
/// reached bits.
#[derive(Accounts)]
pub struct AcknowledgeMilestone<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,
    #[account(
        mut,
        has_one = maker,
        seeds = [b"fundraiser".as_ref(), maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,
}

impl<'info> AcknowledgeMilestone<'info> {
    pub fn acknowledge_milestone(&mut self, index: u8) -> Result<()> {
        require!(
            (index as usize) < MILESTONE_PERCENTS.len(),
            FundraiserError::InvalidMilestone
        );

        let bit = 1u8 << index;

        require!(
            self.fundraiser.milestones_reached & bit != 0,
            FundraiserError::MilestoneNotReached
        );

        require!(
            self.fundraiser.milestones_announced & bit == 0,
            FundraiserError::MilestoneAlreadyAnnounced
        );

        self.fundraiser.milestones_announced |= bit;

        emit!(MilestoneAnnounced {
            fundraiser: self.fundraiser.key(),
            index,
            percent: MILESTONE_PERCENTS[index as usize],
        });

        Ok(())
    }
}
