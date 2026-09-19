import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { strict as assert } from "assert";
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

describe("fundraiser — milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const maker = anchor.web3.Keypair.generate();

  // Multiple contributors are required because each contributor
  // may contribute at most 10% of the fundraiser target.
  const contributors = Array.from(
    { length: 8 },
    () => anchor.web3.Keypair.generate()
  );

  let mint: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;

  const contributorAtas: anchor.web3.PublicKey[] = [];

  const fundraiser = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
    program.programId
  )[0];

  /*
   * Target = 40 tokens with 6 decimals.
   *
   * 25% = 10 tokens
   * 50% = 20 tokens
   * 75% = 30 tokens
   *
   * Maximum contribution per contributor:
   *
   * 40 * 10% = 4 tokens
   */
  const TARGET = 40_000_000;

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction({
      signature,
      ...block,
    });

    return signature;
  };

  const contributorPda = (
    contributor: anchor.web3.PublicKey
  ): anchor.web3.PublicKey => {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        fundraiser.toBuffer(),
        contributor.toBuffer(),
      ],
      program.programId
    )[0];
  };

  const contribute = async (
    contributor: anchor.web3.Keypair,
    contributorAta: anchor.web3.PublicKey,
    amount: number
  ): Promise<string> => {
    const signature = await program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount: contributorPda(contributor.publicKey),
        contributorAta,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor])
      .rpc({
        skipPreflight: true,
      });

    await confirm(signature);

    return signature;
  };

  const getMilestoneEvents = async (signature: string) => {
    const transaction = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    assert.ok(transaction, "transaction should exist");

    assert.ok(
      transaction.meta?.logMessages,
      "transaction should contain log messages"
    );

    const parser = new anchor.EventParser(
      program.programId,
      program.coder
    );

    return [
      ...parser.parseLogs(transaction.meta.logMessages),
    ];
  };

  it("prepares milestone test accounts", async () => {
    await provider.connection
      .requestAirdrop(
        maker.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      )
      .then(confirm);

    /*
     * Every contributor pays for their Contributor PDA when it is first
     * initialized, so each contributor needs SOL.
     */
    for (const contributor of contributors) {
      await provider.connection
        .requestAirdrop(
          contributor.publicKey,
          anchor.web3.LAMPORTS_PER_SOL
        )
        .then(confirm);
    }

    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    for (const contributor of contributors) {
      const ata = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          wallet.payer,
          mint,
          contributor.publicKey
        )
      ).address;

      contributorAtas.push(ata);

      /*
       * Each contributor receives 4 tokens.
       *
       * 4 tokens is exactly the maximum contribution allowed
       * for a fundraiser with a 40-token target.
       */
      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        ata,
        provider.publicKey,
        4_000_000
      );
    }

    vault = getAssociatedTokenAddressSync(
      mint,
      fundraiser,
      true
    );

    assert.equal(
      contributorAtas.length,
      8,
      "all contributor token accounts should be created"
    );
  });

  it("initializes milestones to zero", async () => {
    await program.methods
      .initialize(new anchor.BN(TARGET), 7)
      .accountsPartial({
        maker: maker.publicKey,
        fundraiser,
        mintToRaise: mint,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc({
        skipPreflight: true,
      })
      .then(confirm);

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    assert.equal(
      fundraiserAccount.milestonesFired,
      0,
      "no milestone should be fired when fundraiser is initialized"
    );

    assert.equal(
      fundraiserAccount.currentAmount.toString(),
      "0",
      "fundraiser should start with zero contributions"
    );
  });

  it("does not fire a milestone below 25%", async () => {
    /*
     * First contributor:
     *
     * 4 / 40 = 10%
     */
    await contribute(
      contributors[0],
      contributorAtas[0],
      4_000_000
    );

    /*
     * Second contributor:
     *
     * 8 / 40 = 20%
     *
     * Still below the first 25% milestone.
     */
    const signature = await contribute(
      contributors[1],
      contributorAtas[1],
      4_000_000
    );

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    assert.equal(
      fundraiserAccount.currentAmount.toString(),
      "8000000",
      "fundraiser should contain 8 tokens"
    );

    assert.equal(
      fundraiserAccount.milestonesFired,
      0,
      "20% should not trigger the 25% milestone"
    );

    const events = await getMilestoneEvents(signature);

    assert.equal(
      events.length,
      0,
      "no milestone event should be emitted below 25%"
    );
  });

  it("fires the 25% milestone when the threshold is crossed", async () => {
    /*
     * Existing total:
     *
     * 8 / 40 = 20%
     *
     * Add 3 tokens:
     *
     * 11 / 40 = 27.5%
     *
     * This deliberately crosses 25% instead of landing exactly on it.
     */
    const signature = await contribute(
      contributors[2],
      contributorAtas[2],
      3_000_000
    );

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    assert.equal(
      fundraiserAccount.currentAmount.toString(),
      "11000000",
      "fundraiser should move from 20% to 27.5%"
    );

    /*
     * Bit 0 represents 25%.
     *
     * 00000001 = 1
     */
    assert.equal(
      fundraiserAccount.milestonesFired,
      1,
      "25% milestone bit should be set"
    );

    const events = await getMilestoneEvents(signature);

    assert.equal(
      events.length,
      1,
      "crossing 25% should emit exactly one milestone event"
    );

    assert.equal(
      events[0].data.percentage,
      25,
      "the emitted milestone should be 25%"
    );

    assert.equal(
      events[0].data.currentAmount.toString(),
      "11000000",
      "event should record the amount when 25% was crossed"
    );
  });

  it("does not emit the 25% milestone again", async () => {
    /*
     * Contributor 2 previously contributed 3 tokens.
     *
     * Another token brings that contributor to the maximum
     * permitted cumulative contribution of 4 tokens.
     *
     * Fundraiser:
     *
     * 11 + 1 = 12 tokens
     * 12 / 40 = 30%
     *
     * The 25% event must NOT fire again.
     */
    const signature = await contribute(
      contributors[2],
      contributorAtas[2],
      1_000_000
    );

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    assert.equal(
      fundraiserAccount.currentAmount.toString(),
      "12000000",
      "fundraiser should now contain 12 tokens"
    );

    assert.equal(
      fundraiserAccount.milestonesFired,
      1,
      "25% milestone bit should remain set"
    );

    const events = await getMilestoneEvents(signature);

    assert.equal(
      events.length,
      0,
      "25% milestone must not be emitted twice"
    );
  });

  it("fires the 50% milestone when the threshold is crossed", async () => {
    /*
     * Current fundraiser total = 12 tokens = 30%.
     *
     * 12 + 4 = 16 tokens = 40%
     */
    await contribute(
      contributors[3],
      contributorAtas[3],
      4_000_000
    );

    /*
     * 16 + 3 = 19 tokens = 47.5%
     */
    await contribute(
      contributors[4],
      contributorAtas[4],
      3_000_000
    );

    /*
     * 19 + 2 = 21 tokens
     *
     * 21 / 40 = 52.5%
     *
     * This deliberately crosses the 50% threshold.
     */
    const signature = await contribute(
      contributors[5],
      contributorAtas[5],
      2_000_000
    );

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    assert.equal(
      fundraiserAccount.currentAmount.toString(),
      "21000000",
      "fundraiser should move from 47.5% to 52.5%"
    );

    /*
     * bit 0 = 25%
     * bit 1 = 50%
     *
     * 00000011 = 3
     */
    assert.equal(
      fundraiserAccount.milestonesFired,
      3,
      "25% and 50% milestone bits should be set"
    );

    const events = await getMilestoneEvents(signature);

    assert.equal(
      events.length,
      1,
      "crossing 50% should emit exactly one milestone event"
    );

    assert.equal(
      events[0].data.percentage,
      50,
      "the emitted milestone should be 50%"
    );

    assert.equal(
      events[0].data.currentAmount.toString(),
      "21000000",
      "event should record the amount when 50% was crossed"
    );
  });

  it("fires the 75% milestone when the threshold is crossed", async () => {
    /*
     * Current fundraiser total = 21 tokens = 52.5%.
     *
     * Contributor 5 previously contributed 2 tokens.
     * Another 2 tokens brings that contributor to their 4-token maximum.
     *
     * 21 + 2 = 23 tokens = 57.5%
     */
    await contribute(
      contributors[5],
      contributorAtas[5],
      2_000_000
    );

    /*
     * 23 + 4 = 27 tokens = 67.5%
     */
    await contribute(
      contributors[6],
      contributorAtas[6],
      4_000_000
    );

    /*
     * 27 + 4 = 31 tokens
     *
     * 31 / 40 = 77.5%
     *
     * This deliberately crosses the 75% threshold.
     */
    const signature = await contribute(
      contributors[7],
      contributorAtas[7],
      4_000_000
    );

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    assert.equal(
      fundraiserAccount.currentAmount.toString(),
      "31000000",
      "fundraiser should move from 67.5% to 77.5%"
    );

    /*
     * bit 0 = 25%
     * bit 1 = 50%
     * bit 2 = 75%
     *
     * 00000111 = 7
     */
    assert.equal(
      fundraiserAccount.milestonesFired,
      7,
      "25%, 50%, and 75% milestone bits should all be set"
    );

    const events = await getMilestoneEvents(signature);

    assert.equal(
      events.length,
      1,
      "crossing 75% should emit exactly one milestone event"
    );

    assert.equal(
      events[0].data.percentage,
      75,
      "the emitted milestone should be 75%"
    );

    assert.equal(
      events[0].data.currentAmount.toString(),
      "31000000",
      "event should record the amount when 75% was crossed"
    );
  });
});