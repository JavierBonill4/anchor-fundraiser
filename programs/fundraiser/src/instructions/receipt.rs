use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{mint_to, Mint, MintTo, Token, TokenAccount},
};

use crate::{
    state::{Contributor, Fundraiser},
    FundraiserError, ANCHOR_DISCRIMINATOR,
};

/// Mints the campaign's contribution receipt — one badge token, supply one per
/// person per campaign — to a contributor who has actually put money in.
///
/// Anyone may call this for anyone: the caller pays the fees, the badge always
/// goes to the address whose `Contributor` record proves the contribution. A
/// griefer can only ever be generous on someone else's behalf.
///
/// Idempotent by construction:
/// - `receipt_ata` is `init_if_needed`, so repeat calls reuse the same account;
/// - the transfer is `mint_to(amount = 1)` on a decimals-0 mint, so a second
///   successful call would push that ATA to 2;
/// - `require!(!contributor.claimed, ReceiptAlreadyClaimed)` makes the second
///   call fail outright, and sets the flag *before* the CPI so the token
///   program and this program can never disagree about whether a badge was
///   issued (a failing CPI reverts the whole transaction, flag included).
#[derive(Accounts)]
pub struct ClaimReceipt<'info> {
    /// Pays rent and fees for everything this call creates. Deliberately NOT
    /// checked against any state: the claim is permissionless by design.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Who the badge is for. A signer only if the contributor claims their own
    /// receipt; nobody else needs the key.
    ///
    /// CHECK: deliberately unchecked. This is a bare address the receipt is
    /// minted to: it must equal the `contributor` seed of
    /// `contributor_account` (enforced by that account's seed constraint), it
    /// feeds the `receipt_ata` derivation, and nothing is read from or signed
    /// by it here. Any value the caller passes either matches the derivation
    /// or the seed-constrained account it names fails to resolve.
    pub contributor: UncheckedAccount<'info>,

    #[account(
        mut,
        has_one = mint_to_raise,
        has_one = reward_mint,
        seeds = [b"fundraiser", maker.key().as_ref()],
        bump = fundraiser.bump,
    )]
    pub fundraiser: Account<'info, Fundraiser>,

    /// The maker's key only ever feeds the fundraiser's seeds; it signs nothing.
    ///
    /// CHECK: deliberately unchecked. Only used as the first seed of the
    /// fundraiser PDA, whose bump Anchor verifies against the stored bump — a
    /// wrong key yields a different PDA and the constraint fails. Nothing is
    /// read from or signed by this account.
    pub maker: UncheckedAccount<'info>,

    pub mint_to_raise: Account<'info, Mint>,

    /// The campaign's badge mint. Created in `initialize` with the fundraiser
    /// PDA as its only mint authority, so this program is the only thing on
    /// chain that can increase its supply.
    #[account(mut)]
    pub reward_mint: Account<'info, Mint>,

    /// Proves the contributor actually put money in, and carries the claimed
    /// flag. `init_if_needed` would hand a fresh, zeroed record to a
    /// never-contributor; passing it as `Option` forces the empty case through
    /// `ContributorMissing`, a named error, instead.
    #[account(
        init_if_needed,
        payer = payer,
        seeds = [b"contributor", fundraiser.key().as_ref(), contributor.key().as_ref()],
        bump,
        space = ANCHOR_DISCRIMINATOR + Contributor::INIT_SPACE,
    )]
    pub contributor_account: Option<Account<'info, Contributor>>,

    /// Where the badge lands: the contributor's ATA for the reward mint.
    /// Derived from the accounts above, so nobody can redirect the mint.
    /// Deserialized with `TokenAccount` — not `InterfaceAccount` — because the
    /// badge mint lives in the SPL Token program by construction.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = reward_mint,
        associated_token::authority = contributor,
    )]
    pub receipt_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> ClaimReceipt<'info> {
    pub fn claim_receipt(&mut self, _bumps: &ClaimReceiptBumps) -> Result<()> {
        // The contributor record must exist and show a real stake. A fresh
        // record created by `init_if_needed` (amount == 0) fails this too.
        //
        // `amount > 0` is exactly "contribute accepted at least one whole
        // token from this wallet": contribute's own floor is one whole token
        // of whatever mint the campaign is in, so any live positive record
        // already proves eligibility without duplicating that floor here —
        // and without hard-coding one mint's decimals into a guard the
        // receipt path shares with every mint.
        let contributor_account = self
            .contributor_account
            .as_mut()
            .ok_or(FundraiserError::ContributorMissing)?;

        require!(
            contributor_account.amount > 0,
            FundraiserError::NothingToReceipt
        );

        // One badge, once, ever. See the struct-level comment for why this is
        // airtight against repeat claims.
        require!(
            !contributor_account.claimed,
            FundraiserError::ReceiptAlreadyClaimed
        );

        // The receipt supply is bounded by the number of Contributor records
        // (one per PDA), which is bounded by the number of distinct wallets —
        // so this u64 cannot realistically overflow. checked_add regardless,
        // per the house rule: no bare arithmetic on token amounts.
        let minted = self
            .fundraiser
            .receipts_minted
            .checked_add(1)
            .ok_or(FundraiserError::ReceiptOverflow)?;

        // Flag first, CPI second: if the mint fails the transaction reverts,
        // so the two can never disagree. If the mint succeeds, no further
        // call can pass the `claimed` check above.
        contributor_account.claimed = true;
        self.fundraiser.receipts_minted = minted;

        let cpi_accounts = MintTo {
            mint: self.reward_mint.to_account_info(),
            to: self.receipt_ata.to_account_info(),
            authority: self.fundraiser.to_account_info(),
        };

        let signer_seeds: [&[&[u8]]; 1] = [&[
            b"fundraiser".as_ref(),
            self.maker.to_account_info().key.as_ref(),
            &[self.fundraiser.bump],
        ]];

        // Anchor 1.0 and later: the CpiContext takes the program's address,
        // not its AccountInfo.
        let cpi_ctx = CpiContext::new_with_signer(
            self.token_program.key(),
            cpi_accounts,
            &signer_seeds,
        );

        mint_to(cpi_ctx, 1)?;

        emit!(ReceiptClaimed {
            fundraiser: self.fundraiser.key(),
            contributor: self.contributor.key(),
            reward_mint: self.reward_mint.key(),
            receipt_ata: self.receipt_ata.key(),
            total_minted: minted,
        });

        Ok(())
    }
}

#[event]
pub struct ReceiptClaimed {
    pub fundraiser: Pubkey,
    pub contributor: Pubkey,
    pub reward_mint: Pubkey,
    pub receipt_ata: Pubkey,
    pub total_minted: u64,
}
