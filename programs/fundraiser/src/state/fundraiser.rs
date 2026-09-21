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
    // ---- appended by feat/contribution-receipts (append-only: never insert
    // before an existing field, or pre-existing accounts deserialize as garbage)

    /// The receipt mint this campaign issues to its contributors. Created in
    /// `initialize` with decimals 0 and the fundraiser PDA as mint authority,
    /// so only this program can ever increase the supply.
    pub reward_mint: Pubkey,
    /// How many receipt tokens have been minted so far. Incremented only in
    /// `claim_receipt`, and only by one per live contributor.
    pub receipts_minted: u64,
}