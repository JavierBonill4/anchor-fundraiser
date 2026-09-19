import * as anchor from "@coral-xyz/anchor";
import { EventParser, Program } from "@coral-xyz/anchor";
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

  // A zero-decimal mint makes one raw unit equal one whole token. With a target
  // of 40, the marks are exactly 10, 20 and 30 and the per-contributor cap is 4.
  const TARGET = 40;

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  type MilestoneEvent = {
    fundraiser: anchor.web3.PublicKey;
    quarter: number;
    amount: anchor.BN;
  };

  const fund = async (publicKey: anchor.web3.PublicKey) => {
    const signature = await provider.connection.requestAirdrop(
      publicKey,
      anchor.web3.LAMPORTS_PER_SOL / 10,
    );
    await provider.connection.confirmTransaction(signature, "confirmed");
  };

  const openCampaign = async (): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await fund(maker.publicKey);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      0,
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId,
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new anchor.BN(TARGET), 7)
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    return { maker, mint, fundraiser, vault };
  };

  const eventsFrom = async (signature: string): Promise<MilestoneEvent[]> => {
    const transaction = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    assert.isNotNull(
      transaction,
      "the contribution transaction should be available",
    );

    const parser = new EventParser(program.programId, program.coder);
    return [...parser.parseLogs(transaction!.meta?.logMessages ?? [])]
      .filter((event) => event.name.toLowerCase() === "milestonereached")
      .map((event) => event.data as MilestoneEvent);
  };

  /**
   * Uses a fresh contributor for each call because the program caps every
   * contributor at 10% of the target. Returns only events emitted by this call.
   */
  const contribute = async (
    campaign: Campaign,
    amount: number,
  ): Promise<MilestoneEvent[]> => {
    const contributor = anchor.web3.Keypair.generate();
    await fund(contributor.publicKey);

    const contributorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        campaign.mint,
        contributor.publicKey,
      )
    ).address;
    await mintTo(
      provider.connection,
      wallet.payer,
      campaign.mint,
      contributorAta,
      provider.publicKey,
      amount,
    );

    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        campaign.fundraiser.toBuffer(),
        contributor.publicKey.toBuffer(),
      ],
      program.programId,
    );

    const signature = await program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.publicKey,
        mintToRaise: campaign.mint,
        fundraiser: campaign.fundraiser,
        contributorAccount,
        contributorAta,
        vault: campaign.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor])
      .rpc();

    return eventsFrom(signature);
  };

  it("records and emits all three milestones", async () => {
    const campaign = await openCampaign();
    const fired: number[] = [];

    // Totals after each contribution: 4, 8, 12, 16, 20, 24, 28, 30.
    // The calls reaching 12, 20 and 30 cross the three milestone boundaries.
    for (const amount of [4, 4, 4, 4, 4, 4, 4, 2]) {
      const events = await contribute(campaign, amount);
      fired.push(...events.map((event) => event.quarter));
    }

    assert.deepEqual(fired, [1, 2, 3], "each quarter should emit exactly once");

    const fundraiser = await program.account.fundraiser.fetch(
      campaign.fundraiser,
    );
    assert.strictEqual(
      fundraiser.milestonesFired,
      0b111,
      "all milestone bits should be set",
    );
    assert.strictEqual(fundraiser.currentAmount.toString(), "30");
  });

  it("does not fire one unit below 25% and fires exactly at 25%", async () => {
    const campaign = await openCampaign();

    await contribute(campaign, 4);
    await contribute(campaign, 4);
    const belowEvents = await contribute(campaign, 1); // total = 9

    let fundraiser = await program.account.fundraiser.fetch(
      campaign.fundraiser,
    );
    assert.strictEqual(fundraiser.currentAmount.toString(), "9");
    assert.strictEqual(
      fundraiser.milestonesFired,
      0,
      "25% must not fire at 9/40",
    );
    assert.lengthOf(
      belowEvents,
      0,
      "one unit below the boundary must emit nothing",
    );

    const boundaryEvents = await contribute(campaign, 1); // total = 10
    fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);

    assert.strictEqual(
      fundraiser.milestonesFired,
      0b001,
      "25% must fire at 10/40",
    );
    assert.lengthOf(
      boundaryEvents,
      1,
      "the exact boundary should emit one event",
    );
    assert.strictEqual(boundaryEvents[0].quarter, 1);
    assert.strictEqual(boundaryEvents[0].amount.toString(), "10");
  });

  it("does not emit the 25% milestone twice", async () => {
    const campaign = await openCampaign();

    await contribute(campaign, 4);
    await contribute(campaign, 4);
    const firstCrossing = await contribute(campaign, 2); // total = 10
    assert.deepEqual(
      firstCrossing.map((event) => event.quarter),
      [1],
    );

    const repeatedAttempt = await contribute(campaign, 4); // total = 14
    assert.lengthOf(
      repeatedAttempt,
      0,
      "an already-set milestone must not emit again",
    );

    const fundraiser = await program.account.fundraiser.fetch(
      campaign.fundraiser,
    );
    assert.strictEqual(fundraiser.milestonesFired, 0b001);
    assert.strictEqual(fundraiser.currentAmount.toString(), "14");
  });
});
