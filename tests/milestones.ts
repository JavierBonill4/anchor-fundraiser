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

describe("fundraiser — milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  // 10 tokens target (decimals = 6)
  const TARGET = 10_000_000;
  // 1 token contribution = 10% of target (maximum allowed per contributor)
  const CONTRIBUTION = 1_000_000;
  const DURATION_DAYS = 7;

  const MILESTONE_25 = 1 << 0; // 0b001 = 1
  const MILESTONE_50 = 1 << 1; // 0b010 = 2
  const MILESTONE_75 = 1 << 2; // 0b100 = 4

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  let maker: anchor.web3.Keypair;
  let mint: anchor.web3.PublicKey;
  let fundraiserPDA: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;

  // Track captured events
  const capturedEvents: any[] = [];
  let listenerId: number;

  before(async () => {
    // Subscribe to MilestoneReached events
    listenerId = program.addEventListener(
      "milestoneReached",
      (event, _slot) => {
        capturedEvents.push(event);
      },
    );

    maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    // Create SPL Token mint (6 decimals)
    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6,
    );

    [fundraiserPDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId,
    );

    vault = getAssociatedTokenAddressSync(mint, fundraiserPDA, true);
  });

  after(async () => {
    if (listenerId !== undefined) {
      await program.removeEventListener(listenerId);
    }
  });

  it("Initializes fundraiser with milestone = 0", async () => {
    await program.methods
      .initialize(new anchor.BN(TARGET), DURATION_DAYS)
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser: fundraiserPDA,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc()
      .then(confirm);

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiserPDA);
    assert.strictEqual(
      fundraiserAccount.milestone,
      0,
      "Initial milestone should be 0",
    );
    assert.strictEqual(
      fundraiserAccount.currentAmount.toNumber(),
      0,
      "Initial current_amount should be 0",
    );
  });

  /** Helper to fund a donor keypair, create their ATA, and execute contribute() */
  const makeContribution = async (
    donor: anchor.web3.Keypair,
    amount: number,
  ) => {
    await provider.connection
      .requestAirdrop(donor.publicKey, 0.5 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const donorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        donor.publicKey,
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      donorAta,
      provider.publicKey,
      amount,
    );

    const [donorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        fundraiserPDA.toBuffer(),
        donor.publicKey.toBuffer(),
      ],
      program.programId,
    );

    await program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: donor.publicKey,
        mintToRaise: mint,
        fundraiser: fundraiserPDA,
        contributorAccount: donorAccount,
        contributorAta: donorAta,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([donor])
      .rpc()
      .then(confirm);
  };

  it("10% and 20% contributions do not trigger any milestone", async () => {
    // Donor 1: 10%
    const donor1 = anchor.web3.Keypair.generate();
    await makeContribution(donor1, CONTRIBUTION);

    let state = await program.account.fundraiser.fetch(fundraiserPDA);
    assert.strictEqual(state.currentAmount.toNumber(), 1_000_000);
    assert.strictEqual(
      state.milestone,
      0,
      "Milestone should still be 0 at 10%",
    );

    // Donor 2: 10% (cumulative 20%)
    const donor2 = anchor.web3.Keypair.generate();
    await makeContribution(donor2, CONTRIBUTION);

    state = await program.account.fundraiser.fetch(fundraiserPDA);
    assert.strictEqual(state.currentAmount.toNumber(), 2_000_000);
    assert.strictEqual(
      state.milestone,
      0,
      "Milestone should still be 0 at 20%",
    );
  });

  it("Reaching 30% triggers the 25% milestone (bit 0 set)", async () => {
    // Donor 3: 10% (cumulative 30% -> crosses 25% threshold)
    const donor3 = anchor.web3.Keypair.generate();
    await makeContribution(donor3, CONTRIBUTION);

    const state = await program.account.fundraiser.fetch(fundraiserPDA);
    assert.strictEqual(state.currentAmount.toNumber(), 3_000_000);
    assert.strictEqual(
      state.milestone,
      MILESTONE_25,
      "Milestone bitmask should have bit 0 set (25% milestone reached)",
    );
  });

  it("Reaching 50% triggers the 50% milestone (bit 1 set, total 0b011 = 3)", async () => {
    // Donor 4: 10% (cumulative 40%)
    const donor4 = anchor.web3.Keypair.generate();
    await makeContribution(donor4, CONTRIBUTION);

    let state = await program.account.fundraiser.fetch(fundraiserPDA);
    assert.strictEqual(state.currentAmount.toNumber(), 4_000_000);
    assert.strictEqual(
      state.milestone,
      MILESTONE_25,
      "Milestone should remain 1 at 40%",
    );

    // Donor 5: 10% (cumulative 50% -> hits 50% threshold)
    const donor5 = anchor.web3.Keypair.generate();
    await makeContribution(donor5, CONTRIBUTION);

    state = await program.account.fundraiser.fetch(fundraiserPDA);
    assert.strictEqual(state.currentAmount.toNumber(), 5_000_000);
    assert.strictEqual(
      state.milestone,
      MILESTONE_25 | MILESTONE_50,
      "Milestone bitmask should have bits 0 and 1 set (0b011 = 3)",
    );
  });

  it("Reaching 80% triggers the 75% milestone (bit 2 set, total 0b111 = 7)", async () => {
    // Donor 6: 10% (cumulative 60%)
    const donor6 = anchor.web3.Keypair.generate();
    await makeContribution(donor6, CONTRIBUTION);

    // Donor 7: 10% (cumulative 70%)
    const donor7 = anchor.web3.Keypair.generate();
    await makeContribution(donor7, CONTRIBUTION);

    let state = await program.account.fundraiser.fetch(fundraiserPDA);
    assert.strictEqual(state.currentAmount.toNumber(), 7_000_000);
    assert.strictEqual(
      state.milestone,
      MILESTONE_25 | MILESTONE_50,
      "Milestone should remain 3 at 70%",
    );

    // Donor 8: 10% (cumulative 80% -> crosses 75% threshold)
    const donor8 = anchor.web3.Keypair.generate();
    await makeContribution(donor8, CONTRIBUTION);

    state = await program.account.fundraiser.fetch(fundraiserPDA);
    assert.strictEqual(state.currentAmount.toNumber(), 8_000_000);
    assert.strictEqual(
      state.milestone,
      MILESTONE_25 | MILESTONE_50 | MILESTONE_75,
      "Milestone bitmask should have bits 0, 1, and 2 set (0b111 = 7)",
    );
  });

  it("Subsequent contributions do not re-trigger milestones", async () => {
    // Donor 9: 10% (cumulative 90%)
    const donor9 = anchor.web3.Keypair.generate();
    await makeContribution(donor9, CONTRIBUTION);

    const state = await program.account.fundraiser.fetch(fundraiserPDA);
    assert.strictEqual(state.currentAmount.toNumber(), 9_000_000);
    assert.strictEqual(
      state.milestone,
      7,
      "Milestone bitmask should stay latched at 7",
    );
  });
});
