use anchor_lang::prelude::*;

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
    pub milestones: u8,        // bitmask: bit0=25%, bit1=50%, bit2=75%,
}
impl Fundraiser {
    /// Bit i is set once current_amount has reached MILESTONE_PERCENTAGES[i]
    /// percent of amount_to_raise. Pure function of the two amounts, so
    /// calling it after a contribution (amount went up) can only add bits,
    /// and calling it after a refund (amount went down) can only remove
    /// them — the same rule decides both directions, so contribute and
    /// refund can never disagree about which milestones are still earned.
    pub fn milestones_for(current_amount: u64, amount_to_raise: u64) -> Result<u8> {
        const MILESTONE_PERCENTAGES: [u64; 3] = [25, 50, 75];
        let mut bits: u8 = 0;
        for (i, pct) in MILESTONE_PERCENTAGES.iter().enumerate() {
            let threshold = amount_to_raise
                .checked_mul(*pct)
                .ok_or(crate::FundraiserError::MilestoneOverflow)?
                / 100;
            if current_amount >= threshold && threshold > 0 {
                bits |= 1 << i;
            }
        }
        Ok(bits)
    }
}
