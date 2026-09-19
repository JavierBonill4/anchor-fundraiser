# Fundraiser: Lifecycle Cleanup & Maker Cancel

## What it does
This version of the Fundraiser contract adds an early exit option for makers and fixes a critical state-bloat bug. The maker can now `cancel` the crowdfund before the target is met, immediately failing the crowdfund and opening refunds. Additionally, this version ensures that all Vaults and Program Derived Addresses (PDAs) are properly closed and their rent returned to the users when they are no longer needed, preventing "stranded" state on the Solana network.

## How it works
- **State Changes:** Added `cancelled: bool` and `target_met: bool` to the `Fundraiser` account.
- **Cancel Instruction:** A new `cancel` instruction flips `cancelled = true`. 
- **Refund Adjustments:** The `refund` instruction was updated to allow refunds if the time is up *or* if `cancelled == true`. During the `refund` process, if the `vault` balance exactly matches the contributor's remaining refund amount (meaning this is the absolute last person to withdraw), the program executes a raw CPI to `token::close_account` to close the `vault` ATA, and then manually closes the `Fundraiser` PDA, transferring all lamports to the maker.
- **Success Cleanup:** The `check_contributions` instruction now uses a raw CPI to close the `vault` immediately upon draining it to the maker. It also sets `target_met = true` instead of closing the `Fundraiser` PDA immediately.
- **Contributor Cleanup:** A new `cleanup_contributor` instruction was added so that contributors can close their `Contributor` PDAs and reclaim their rent *after* a successful campaign (which was previously impossible since the `fundraiser` PDA was prematurely closed).

## What it costs
- **Extra Accounts:** 0 extra accounts are strictly required in the base paths, though the `close_account` CPI requires passing the token program. 
- **Extra Compute Units (CU):** The `cancel` instruction uses minimal CU (just state modification). The `refund` instruction uses extra CU on the *last* caller due to the additional `close_account` CPI and manual lamport transfers, but it is well within the 200k limit.
- **Extra Rent:** 2 extra bytes in the `Fundraiser` account to store the two boolean flags (`cancelled` and `target_met`), which adds negligible rent. In fact, this feature *saves* rent globally by ensuring thousands of `Contributor` PDAs and the `Vault` ATA are not left orphaned on the network.

## How you would attack it
- **The Last Refund Attack:** Because the *last* person to refund is forced to pay the Compute Units to close the Vault and Fundraiser PDA, an attacker (or just selfish users) could intentionally refund early to avoid paying the slightly higher transaction fee, leaving the very last contributor stuck with a slightly more expensive transaction. 
- **Stranded Dust:** If someone maliciously sends 1 micro-token directly to the `vault` bypassing our `contribute` function, the vault's balance will never exactly equal the last contributor's amount (since the program only subtracts tracked contributions). This means the `vault.amount == contributor_account.amount` condition in `refund` would never trigger, and the vault and fundraiser PDA would be permanently stranded, successfully griefing the maker's rent. To fix this, we would need a sweeping function or change the logic to close the vault if the remaining balance is less than or equal to the final refund amount.
