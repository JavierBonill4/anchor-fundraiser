import * as anchor from "@coral-xyz/anchor";
import {
  Program,
} from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  assert,
} from "chai";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";

import {
  Fundraiser,
} from "../target/types/fundraiser";

/**
 * Tests the custom Backer Receipt NFT feature.
 *
 * The receipt is:
 * - available only after a valid contribution
 * - unique to one fundraiser and contributor
 * - a zero-decimal mint with a supply of exactly one
 * - frozen after minting so it cannot be transferred
 * - protected against duplicate mint attempts
 */
describe("backer receipt NFT", () => {
  // Connect the test to the local validator started by `anchor test`.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program =
    anchor.workspace.Fundraiser as Program<Fundraiser>;

  const wallet = provider.wallet as NodeWallet;

  // Use a fresh maker so this test does not share fundraiser state
  // with the starter tests.
  const maker = anchor.web3.Keypair.generate();

  let fundraisingMint: anchor.web3.PublicKey;
  let contributorAta: anchor.web3.PublicKey;

  // One token with six decimal places equals 1,000,000 raw units.
  const ONE_TOKEN = 1_000_000;

  // The fundraiser requests thirty whole tokens.
  const TARGET_AMOUNT = 30_000_000;

  // A contributor may contribute at most ten percent of the target.
  const VALID_CONTRIBUTION = ONE_TOKEN;

  // Derive the fundraiser PDA from the maker.
  const [fundraiser] =
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("fundraiser"),
        maker.publicKey.toBuffer(),
      ],
      program.programId
    );

  // Derive the contributor PDA from the fundraiser and contributor.
  const [contributorAccount] =
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        fundraiser.toBuffer(),
        provider.publicKey.toBuffer(),
      ],
      program.programId
    );

  // Derive the unique receipt mint for this fundraiser and contributor.
  const [receiptMint] =
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("receipt"),
        fundraiser.toBuffer(),
        provider.publicKey.toBuffer(),
      ],
      program.programId
    );

  // This is the wallet account that will hold the receipt token.
  const receiptAta = getAssociatedTokenAddressSync(
    receiptMint,
    provider.publicKey
  );

  /**
   * Extracts an Anchor error name from a failed transaction.
   *
   * This allows the tests to prove that the program returned the
   * intended named error instead of merely failing for any reason.
   */
  const errorCodeOf = (error: any): string => {
    return (
      error?.error?.errorCode?.code ??
      error?.errorCode?.code ??
      error?.code ??
      error?.message ??
      "UnknownError"
    );
  };

  before(async () => {
    // Fund the maker so it can pay to create the fundraiser and vault.
    const airdropSignature =
      await provider.connection.requestAirdrop(
        maker.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      );

    const latestBlockhash =
      await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction({
      signature: airdropSignature,
      ...latestBlockhash,
    });

    // Create the six-decimal SPL token accepted by the fundraiser.
    fundraisingMint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    // Create the contributor's token account.
    contributorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        fundraisingMint,
        provider.publicKey
      )
    ).address;

    // Give the contributor ten tokens for testing.
    await mintTo(
      provider.connection,
      wallet.payer,
      fundraisingMint,
      contributorAta,
      provider.publicKey,
      10 * ONE_TOKEN
    );

    // Create a seven-day fundraiser.
    const vault = getAssociatedTokenAddressSync(
      fundraisingMint,
      fundraiser,
      true
    );

    await program.methods
      .initialize(
        new anchor.BN(TARGET_AMOUNT),
        7
      )
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: fundraisingMint,
        fundraiser,
        vault,
        systemProgram:
          anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram:
          ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([
        maker,
      ])
      .rpc();
  });

  /**
   * Boundary test:
   *
   * A contribution one raw unit below one full token must fail.
   * Because Solana transactions are atomic, the Contributor PDA must
   * not remain behind after the rejected instruction.
   */
  it("rejects a contribution below one whole token", async () => {
    const vault = getAssociatedTokenAddressSync(
      fundraisingMint,
      fundraiser,
      true
    );

    let rejectedError: any;

    try {
      await program.methods
        .contribute(
          new anchor.BN(ONE_TOKEN - 1)
        )
        .accountsPartial({
          contributor: provider.publicKey,
          mintToRaise: fundraisingMint,
          fundraiser,
          contributorAccount,
          contributorAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram:
            anchor.web3.SystemProgram.programId,
        })
        .rpc();
    } catch (error) {
      rejectedError = error;
    }

    assert.isDefined(
      rejectedError,
      "a contribution below one token must be rejected"
    );

    assert.strictEqual(
      errorCodeOf(rejectedError).toLowerCase(),
      "contributiontoosmall",
      "the program should return ContributionTooSmall"
    );

    const rejectedContributorAccount =
      await provider.connection.getAccountInfo(
        contributorAccount
      );

    assert.isNull(
      rejectedContributorAccount,
      "the rejected contribution must not leave a Contributor PDA"
    );
  });

  /**
   * Happy-path test:
   *
   * After contributing one valid token, the wallet receives exactly
   * one zero-decimal frozen receipt and its state flag becomes true.
   */
  it("mints one frozen receipt after a valid contribution", async () => {
    const vault = getAssociatedTokenAddressSync(
      fundraisingMint,
      fundraiser,
      true
    );

    // Make one valid contribution.
    await program.methods
      .contribute(
        new anchor.BN(VALID_CONTRIBUTION)
      )
      .accountsPartial({
        contributor: provider.publicKey,
        mintToRaise: fundraisingMint,
        fundraiser,
        contributorAccount,
        contributorAta,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram:
          anchor.web3.SystemProgram.programId,
      })
      .rpc();

    // The receipt flag should still be false before minting.
    const contributorBeforeReceipt =
      await program.account.contributor.fetch(
        contributorAccount
      );

    assert.isFalse(
      contributorBeforeReceipt.receiptMinted,
      "the receipt flag should begin as false"
    );

    // Mint the contributor's one-time receipt NFT.
    await program.methods
      .mintReceipt()
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser,
        contributorAccount,
        receiptMint,
        receiptAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram:
          ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram:
          anchor.web3.SystemProgram.programId,
      })
      .rpc();

    // Confirm the mint behaves like a one-of-one receipt.
    const mintState = await getMint(
      provider.connection,
      receiptMint
    );

    assert.strictEqual(
      mintState.decimals,
      0,
      "the receipt mint must have zero decimals"
    );

    assert.strictEqual(
      mintState.supply,
      1n,
      "the receipt mint must have a total supply of one"
    );

    // Confirm the contributor owns exactly one frozen receipt.
    const receiptAccount = await getAccount(
      provider.connection,
      receiptAta
    );

    assert.strictEqual(
      receiptAccount.amount,
      1n,
      "the contributor should own exactly one receipt"
    );

    assert.isTrue(
      receiptAccount.isFrozen,
      "the receipt must be frozen and non-transferable"
    );

    // Confirm the program recorded the one-time mint.
    const contributorAfterReceipt =
      await program.account.contributor.fetch(
        contributorAccount
      );

    assert.isTrue(
      contributorAfterReceipt.receiptMinted,
      "the contributor state must record that the receipt was minted"
    );

    assert.strictEqual(
      contributorAfterReceipt.amount.toString(),
      VALID_CONTRIBUTION.toString(),
      "minting the receipt must not change the contribution amount"
    );
  });

  /**
   * Abuse test:
   *
   * The same wallet must not be able to mint another receipt for
   * the same fundraiser.
   */
  it("rejects a duplicate receipt with a named error", async () => {
    let duplicateError: any;

    try {
      await program.methods
        .mintReceipt()
        .accountsPartial({
          contributor: provider.publicKey,
          fundraiser,
          contributorAccount,
          receiptMint,
          receiptAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram:
            ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram:
            anchor.web3.SystemProgram.programId,
        })
        .rpc();
    } catch (error) {
      duplicateError = error;
    }

    assert.isDefined(
      duplicateError,
      "a second receipt request must be rejected"
    );

    assert.strictEqual(
      errorCodeOf(duplicateError).toLowerCase(),
      "receiptalreadyminted",
      "the program should return ReceiptAlreadyMinted"
    );

    // The failed abuse attempt must not increase the supply.
    const mintState = await getMint(
      provider.connection,
      receiptMint
    );

    assert.strictEqual(
      mintState.supply,
      1n,
      "the receipt supply must remain one after a duplicate attempt"
    );
  });
});