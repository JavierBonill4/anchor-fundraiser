use anchor_lang::prelude::*;

/// One per contributor per campaign, created by `contribute` and closed by
/// `refund`. Lives as long as the contributor has skin in the game.
///
/// `feat/contribution-receipts` appends a field (never inserts: Borsh lays
/// fields out in declaration order, and shifting a byte would corrupt every
/// account created before the change). Accounts created before the change are
/// still valid: Borsh simply reads past the old four bytes of `amount` and the
/// new `claimed` bool reads as whatever follows — for an account re-created
/// after the change that is a zeroed byte, i.e. `false`, which is exactly the
/// value an unclaimed contributor should have.
#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64,

    /// Set once, in `claim_receipt`, when this contributor's badge is minted.
    /// Deliberately NOT reset by `refund`: one badge per person per campaign,
    /// even if they take their money back afterwards.
    pub claimed: bool,
}
