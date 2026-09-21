# Receipt NFTs

## What It Does

A contributor can receive a receipt NFT as proof that they contributed to a successful fundraiser.

The receipt is not created when the contribution is made. It is created only after:

1. The fundraiser duration has ended.
2. The fundraiser has reached its target amount.
3. The contributor claims their receipt.

The receipt is a Token-2022 non-fungible token with a supply of exactly one. It is minted directly into the contributor's Token-2022 associated token account.

The contribution token and fundraiser vault still use the regular SPL Token program. Token-2022 is used only for receipt NFTs.

## How It Works

### State

Each contributor has a contributor PDA containing:

```rust
#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64,
    pub receipt_claimed: bool,
}
```

`amount` records the contributor's total contribution for this fundraiser. `receipt_claimed` prevents the same contributor from claiming a receipt twice.

The fundraiser state continues to hold the target, current amount, start time, duration, maker, and mint information. The receipt instruction reads that state but does not change the fundraiser amount.

### When Receipt Minting Fires

The `issue_receipt` instruction runs after the duration has ended. It checks:

```rust
current_time >= time_started + duration
```

It also checks:

```rust
current_amount >= amount_to_raise
```

If either check fails, no receipt is minted.

The instruction then checks `receipt_claimed`. If it is already true, the instruction fails with `ReceiptAlreadyClaimed`.

### Accounts Involved

The receipt instruction uses these accounts:

- `contributor`: the contributor who signs the transaction and pays for new accounts.
- `fundraiser`: the fundraiser PDA, verified from the maker address and stored bump.
- `contributor_account`: the contributor PDA for this fundraiser and contributor.
- `receipt_mint`: a deterministic Token-2022 mint PDA derived from:

  ```text
  ["receipt-mint", fundraiser, contributor]
  ```

- `contributor_receipt_ata`: the contributor's Token-2022 associated token account for the receipt mint.
- `token_program`: the Token-2022 program for the receipt mint and mint-to CPI.
- `associated_token_program`: creates the receipt ATA when needed.
- `system_program`: pays for account creation.

The contributor signs the outer transaction. The fundraiser PDA signs the Token-2022 `mint_to` CPI using its PDA seeds, so the fundraiser remains the mint authority without having a private key.

The contribution flow is unchanged:

```text
contributor ATA --legacy SPL Token--> fundraiser vault
fundraiser vault --legacy SPL Token, fundraiser PDA signs--> maker ATA
```

The receipt flow is:

```text
fundraiser PDA --Token-2022 mint_to--> contributor receipt ATA
```

## What It Costs

### Extra Accounts

A successful claim creates two receipt-related accounts if they do not already exist:

1. A Token-2022 mint account.
2. A Token-2022 associated token account owned by the contributor.

The contributor pays the rent for both accounts and the transaction fee. The fundraiser program does not pay these costs.

The receipt mint is a basic Token-2022 mint at this stage. It does not yet include a metadata pointer or on-mint metadata extension.

### Rent

The exact lamport cost depends on the cluster's rent schedule. The additional cost is approximately:

- One rent-exempt mint account.
- One rent-exempt token account.
- One normal transaction fee.

The accounts remain on-chain after the claim. A future cleanup instruction could close them only when the token is no longer needed and the relevant authority rules allow it.

### Compute

The successful bankrun test measured approximately 56,000 compute units for the first claim when the receipt mint and ATA were created. That includes account creation, ATA creation, and the Token-2022 mint operation.

A repeated claim reaches the program's duplicate-claim check and uses approximately 17,000 compute units before failing with `ReceiptAlreadyClaimed`.

The receipt change does not add compute to ordinary contributions because contributions still use the existing legacy SPL Token path.

## How It Could Be Attacked

The honest soft spot is lifecycle and liveness, not mint authority.

### A Contributor Can Refuse to Claim

The fundraiser can succeed while one or more contributors never call `issue_receipt`. The fundraiser account must therefore remain open until the application has a policy for unclaimed receipts. A future close instruction should not assume that every contributor will claim automatically.

### Receipt Claims Are User-Paid

Because the contributor pays for the mint and ATA, a contributor without enough SOL cannot claim even if they qualified. A relayer or sponsored claim flow may be needed for a production application.

### The Receipt Is Not Yet Richly Identifiable

The current receipt is a Token-2022 NFT, but it has no `MetadataPointer`, name, symbol, or URI. Wallets will see the token account and mint, but not necessarily a human-readable receipt. Adding metadata requires allocating the mint with Token-2022 extension space before initialization.

### The Fundraiser PDA Must Stay Alive

The fundraiser PDA is the mint authority used by the receipt CPI. Closing it before claims finish would make later receipt claims impossible. This is why `check_contributions` must not close the fundraiser account.

### Accounting Must Remain Program-Controlled

Receipt eligibility depends on `fundraiser.current_amount` and `fundraiser.amount_to_raise`. Those values must only be changed by validated program instructions. A future settlement or close instruction should also prevent repeated fund transfers and should record whether the fundraiser has already been settled.

### Current Test Coverage

The receipt test covers:

- Successful claim: one Token-2022 NFT is minted and owned by the contributor.
- Boundary: below the target fails with `TargetNotMet`; exactly at the target succeeds.
- Abuse: a second claim fails with `ReceiptAlreadyClaimed`.

These tests assert on on-chain balances, mint supply, state flags, and exact Anchor error codes.
