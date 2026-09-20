import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { assert } from "chai";

describe("fundraiser — milestone tracking and events", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      signature,
      ...block,
    });
    return signature;
  };

  it("accurately tracks 25%, 50%, and 75% milestones and emits events idempotently", async () => {
    // 1. Setup maker and mint (6 decimals)
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      null,
      6
    );

    // Target = 40 tokens (40_000_000 raw units)
    // 25% milestone = 10_000_000 units
    // 50% milestone = 20_000_000 units
    // 75% milestone = 30_000_000 units
    // Maximum per contributor = 10% = 4_000_000 units
    const targetAmount = new anchor.BN(40_000_000);
    const durationDays = 7;

    const [fundraiserPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );

    const vault = getAssociatedTokenAddressSync(mint, fundraiserPda, true);

    // Initialize fundraiser
    await program.methods
      .initialize(targetAmount, durationDays)
      .accountsPartial({
        maker: maker.publicKey,
        fundraiser: fundraiserPda,
        mintToRaise: mint,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc()
      .then(confirm);

    // Assert initial state
    let fundraiserAccount = await program.account.fundraiser.fetch(fundraiserPda);
    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      0,
      "milestones_fired must initialize to 0"
    );
    assert.strictEqual(
      fundraiserAccount.currentAmount.toNumber(),
      0,
      "current_amount must initialize to 0"
    );

    // Set up event listener
    const emittedEvents: Array<{
      fundraiser: anchor.web3.PublicKey;
      milestonePercentage: number;
      currentAmount: anchor.BN;
      targetAmount: anchor.BN;
    }> = [];

    const listenerId = program.addEventListener(
      "milestoneReached",
      (event: any) => {
        emittedEvents.push({
          fundraiser: event.fundraiser,
          milestonePercentage: event.milestonePercentage,
          currentAmount: event.currentAmount,
          targetAmount: event.targetAmount,
        });
      }
    );

    // Helper to fund a contributor and submit a contribution
    const contributeAs = async (
      contributorKeypair: anchor.web3.Keypair,
      amount: number
    ) => {
      await provider.connection
        .requestAirdrop(
          contributorKeypair.publicKey,
          1 * anchor.web3.LAMPORTS_PER_SOL
        )
        .then(confirm);

      const contributorAta = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          wallet.payer,
          mint,
          contributorKeypair.publicKey
        )
      ).address;

      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        contributorAta,
        provider.publicKey,
        amount
      );

      const [contributorAccountPda] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from("contributor"),
            fundraiserPda.toBuffer(),
            contributorKeypair.publicKey.toBuffer(),
          ],
          program.programId
        );

      await program.methods
        .contribute(new anchor.BN(amount))
        .accountsPartial({
          contributor: contributorKeypair.publicKey,
          fundraiser: fundraiserPda,
          contributorAccount: contributorAccountPda,
          contributorAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([contributorKeypair])
        .rpc()
        .then(confirm);
    };

    // --- PHASE 1: EXACT 25% BOUNDARY TEST ---
    // Contributor 1: 4 tokens (total = 4 tokens, 10% of target)
    const c1 = anchor.web3.Keypair.generate();
    await contributeAs(c1, 4_000_000);
    fundraiserAccount = await program.account.fundraiser.fetch(fundraiserPda);
    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      0,
      "At 10%, no milestones should have fired"
    );

    // Contributor 2: 4 tokens (total = 8 tokens, 20% of target - strictly below 25%)
    const c2 = anchor.web3.Keypair.generate();
    await contributeAs(c2, 4_000_000);
    fundraiserAccount = await program.account.fundraiser.fetch(fundraiserPda);
    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      0,
      "At 20%, 25% milestone must NOT have fired yet"
    );

    // Contributor 3: 2 tokens (total = 10 tokens, EXACTLY 25% of target)
    const c3 = anchor.web3.Keypair.generate();
    await contributeAs(c3, 2_000_000);
    fundraiserAccount = await program.account.fundraiser.fetch(fundraiserPda);
    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      1,
      "At exactly 25%, bit 0 (25% milestone) must be set (value 1)"
    );

    // Give websocket a brief moment to deliver event
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.isAtLeast(emittedEvents.length, 1, "Expected 25% event emitted");
    assert.strictEqual(emittedEvents[0].milestonePercentage, 25);
    assert.strictEqual(emittedEvents[0].currentAmount.toNumber(), 10_000_000);
    assert.strictEqual(emittedEvents[0].targetAmount.toNumber(), 40_000_000);

    // --- PHASE 2: CROSSING 50% MILESTONE ---
    // Contributor 3: another 2 tokens (total = 12 tokens, 30%)
    await contributeAs(c3, 2_000_000);
    fundraiserAccount = await program.account.fundraiser.fetch(fundraiserPda);
    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      1,
      "At 30%, milestones_fired should remain 1"
    );

    // Contributor 4: 4 tokens (total = 16 tokens, 40%)
    const c4 = anchor.web3.Keypair.generate();
    await contributeAs(c4, 4_000_000);
    fundraiserAccount = await program.account.fundraiser.fetch(fundraiserPda);
    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      1,
      "At 40%, milestones_fired should remain 1"
    );

    // Contributor 5: 4 tokens (total = 20 tokens, EXACTLY 50% milestone)
    const c5 = anchor.web3.Keypair.generate();
    await contributeAs(c5, 4_000_000);
    fundraiserAccount = await program.account.fundraiser.fetch(fundraiserPda);
    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      3,
      "At 50%, bits 0 and 1 must be set (value 3: 0b0011)"
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.isAtLeast(emittedEvents.length, 2, "Expected 50% event emitted");
    assert.strictEqual(emittedEvents[1].milestonePercentage, 50);

    // --- PHASE 3: CROSSING 75% MILESTONE ---
    // Contributor 6: 4 tokens (total = 24 tokens, 60%)
    const c6 = anchor.web3.Keypair.generate();
    await contributeAs(c6, 4_000_000);

    // Contributor 7: 4 tokens (total = 28 tokens, 70%)
    const c7 = anchor.web3.Keypair.generate();
    await contributeAs(c7, 4_000_000);

    // Contributor 8: 2 tokens (total = 30 tokens, EXACTLY 75% milestone)
    const c8 = anchor.web3.Keypair.generate();
    await contributeAs(c8, 2_000_000);
    fundraiserAccount = await program.account.fundraiser.fetch(fundraiserPda);
    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      7,
      "At 75%, bits 0, 1, and 2 must be set (value 7: 0b0111)"
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.isAtLeast(emittedEvents.length, 3, "Expected 75% event emitted");
    assert.strictEqual(emittedEvents[2].milestonePercentage, 75);

    // --- PHASE 4: IDEMPOTENCY TEST ---
    // Contributor 8: another 1 token (total = 31 tokens, 77.5%)
    // Milestones must stay 7 and no duplicate events should fire
    const eventCountBefore = emittedEvents.length;
    await contributeAs(c8, 1_000_000);
    fundraiserAccount = await program.account.fundraiser.fetch(fundraiserPda);
    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      7,
      "Subsequent contributions past 75% must keep milestones_fired = 7"
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.strictEqual(
      emittedEvents.length,
      eventCountBefore,
      "No duplicate milestone events should have been emitted"
    );

    // Clean up event listener
    await program.removeEventListener(listenerId);
  });

  it("enforces maximum contribution limits and reject violations", async () => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      null,
      6
    );

    const targetAmount = new anchor.BN(30_000_000); // 30 tokens
    const [fundraiserPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiserPda, true);

    await program.methods
      .initialize(targetAmount, 7)
      .accountsPartial({
        maker: maker.publicKey,
        fundraiser: fundraiserPda,
        mintToRaise: mint,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc()
      .then(confirm);

    const contributor = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(contributor.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const contributorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        contributor.publicKey
      )
    ).address;

    // Mint 10 tokens to contributor
    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      contributorAta,
      provider.publicKey,
      10_000_000
    );

    const [contributorAccountPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          fundraiserPda.toBuffer(),
          contributor.publicKey.toBuffer(),
        ],
        program.programId
      );

    // Attempt to contribute 4 tokens (13.3% of target), where max allowed is 10% (3 tokens)
    try {
      await program.methods
        .contribute(new anchor.BN(4_000_000))
        .accountsPartial({
          contributor: contributor.publicKey,
          fundraiser: fundraiserPda,
          contributorAccount: contributorAccountPda,
          contributorAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([contributor])
        .rpc();
      assert.fail("Expected ContributionTooBig error to be thrown");
    } catch (err: any) {
      assert.strictEqual(
        err.error?.errorCode?.code,
        "ContributionTooBig",
        "Must reject contribution exceeding 10% of target"
      );
    }
  });
});
