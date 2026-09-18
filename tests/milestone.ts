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

/**
 * Milestone tracking — 25%, 50% and 75% of the target.
 *
 * `contribute` records which quarter-marks a campaign has crossed in a
 * one-byte `milestones_fired` bitmask on `Fundraiser` and emits a
 * `MilestoneReached` event the moment a mark is crossed. Each bit is set
 * exactly once: the flag is guarded, so a later contribution that still sits
 * past the mark can never re-fire it, and a refund does not retract it.
 *
 * The shipped `fundraiser.ts` only logged, so "tests pass" proved nothing.
 * These tests assert on the on-chain flag and count the `MilestoneReached`
 * events in the transaction logs, so they fail if the feature is deleted.
 */
describe("fundraiser - milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  // 30 whole tokens at 6 decimals. Marks at 7.5M (25%), 15M (50%), 22.5M (75%).
  // `contribute` caps every contribution at 10% of the target (3M), so reaching
  // a mark always needs several distinct contributors.
  const TARGET = 30_000_000;
  const MAX_PER_CONTRIBUTOR = (TARGET * 10) / 100; // 3_000_000
  const Q25 = TARGET / 4; // 7_500_000
  const Q50 = TARGET / 2; // 15_000_000
  const Q75 = (TARGET * 3) / 4; // 22_500_000

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  /** A fresh maker, mint and campaign so each test is independent. */
  const openCampaign = async (): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
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
      .rpc()
      .then(confirm);

    return { maker, mint, fundraiser, vault };
  };

  /** A fresh wallet with SOL for rent, used once as a contributor. */
  const newContributor = async (): Promise<anchor.web3.Keypair> => {
    const kp = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(kp.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);
    return kp;
  };

  /**
   * Creates the contributor's ATA, mints `amount` tokens to it, then
   * contributes `amount` to the campaign with the contributor signing.
   * Returns the transaction signature so the caller can inspect its events.
   */
  const contribute = async (
    c: Campaign,
    contributor: anchor.web3.Keypair,
    amount: number
  ): Promise<string> => {
    const ata = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        c.mint,
        contributor.publicKey
      )
    ).address;

    // The mint authority is the provider wallet, so the test can mint any
    // amount to a contributor who does not own tokens yet.
    await mintTo(
      provider.connection,
      wallet.payer,
      c.mint,
      ata,
      provider.publicKey,
      amount
    );

    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        c.fundraiser.toBuffer(),
        contributor.publicKey.toBuffer(),
      ],
      program.programId
    );

    return program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount,
        contributorAta: ata,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor])
      .rpc()
      .then(confirm);
  };

  const flagsOf = async (c: Campaign): Promise<number> => {
    const fundraiser = await program.account.fundraiser.fetch(c.fundraiser);
    return fundraiser.milestonesFired;
  };

  const currentAmountOf = async (c: Campaign): Promise<number> => {
    const fundraiser = await program.account.fundraiser.fetch(c.fundraiser);
    return fundraiser.currentAmount.toNumber();
  };

  /** Every `MilestoneReached` event emitted by the given transaction. */
  const milestoneEventsOf = async (signature: string) => {
    const parsed = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = parsed?.meta?.logMessages ?? [];
    const parser = new anchor.EventParser(program.programId, program.coder);
    return [...parser.parseLogs(logs)].filter(
      (e) => e.name.toLowerCase() === "milestonereached"
    );
  };

  // ------------------------------------------------------------------
  // The boundary - 25% is the discriminating input
  // ------------------------------------------------------------------

  it("fires no milestone when contributions sit one unit below 25%", async () => {
    const c = await openCampaign();

    // 3M + 3M + 1,499,999 = 7,499,999 - the largest total that must NOT fire.
    await contribute(c, await newContributor(), MAX_PER_CONTRIBUTOR);
    await contribute(c, await newContributor(), MAX_PER_CONTRIBUTOR);
    await contribute(c, await newContributor(), Q25 - 2 * MAX_PER_CONTRIBUTOR - 1);

    assert.strictEqual(
      await currentAmountOf(c),
      Q25 - 1,
      "the contributions should have landed in the vault"
    );
    assert.strictEqual(
      await flagsOf(c),
      0,
      "one unit below 25% must not fire"
    );
  });

  it("fires the 25% mark exactly when the total reaches 25%", async () => {
    const c = await openCampaign();

    // 3M + 3M + 1,500,000 = 7,500,000 - exactly one quarter of the target.
    await contribute(c, await newContributor(), MAX_PER_CONTRIBUTOR);
    await contribute(c, await newContributor(), MAX_PER_CONTRIBUTOR);
    const sig = await contribute(
      c,
      await newContributor(),
      Q25 - 2 * MAX_PER_CONTRIBUTOR
    );

    assert.strictEqual(
      await currentAmountOf(c),
      Q25,
      "the contributions should land exactly on 25%"
    );
    assert.strictEqual(
      await flagsOf(c),
      1,
      "exactly 25% must fire the first mark"
    );

    const events = await milestoneEventsOf(sig);
    assert.lengthOf(events, 1, "crossing 25% emits exactly one event");
    assert.strictEqual(events[0].data.quarter, 0, "25% is quarter 0");
    assert.strictEqual(
      events[0].data.amount.toString(),
      String(Q25),
      "the event reports the total that crossed the mark"
    );
  });

  // ------------------------------------------------------------------
  // The happy path - crossing 25%, 50% and 75%
  // ------------------------------------------------------------------

  it("sets all three bits and emits an event at each mark", async () => {
    const c = await openCampaign();

    // First two contributors bring the total to 20% - no mark is crossed.
    await contribute(c, await newContributor(), MAX_PER_CONTRIBUTOR);
    await contribute(c, await newContributor(), MAX_PER_CONTRIBUTOR);
    assert.strictEqual(await flagsOf(c), 0, "20% must not fire anything");

    // Third contribution lands at 30%, jumping over the 25% mark.
    const sig25 = await contribute(c, await newContributor(), MAX_PER_CONTRIBUTOR);
    assert.strictEqual(await flagsOf(c), 0b001, "30% must have fired 25% only");
    assert.lengthOf(
      await milestoneEventsOf(sig25),
      1,
      "crossing 25% emits one event"
    );

    // Fourth contribution pushes to 40% - the 25% condition is still true, but
    // the guard must stop it from re-firing.
    const sig40 = await contribute(c, await newContributor(), MAX_PER_CONTRIBUTOR);
    assert.strictEqual(await flagsOf(c), 0b001, "40% must not re-fire 25%");
    assert.lengthOf(
      await milestoneEventsOf(sig40),
      0,
      "a contribution past an already fired mark emits no event"
    );

    // Fifth contribution lands exactly on 50%, crossing the second mark.
    const sig50 = await contribute(c, await newContributor(), MAX_PER_CONTRIBUTOR);
    assert.strictEqual(await flagsOf(c), 0b011, "50% must have fired 25%+50%");
    assert.lengthOf(
      await milestoneEventsOf(sig50),
      1,
      "crossing 50% emits exactly one event"
    );

    // Sixth and seventh land at 60% and 70%, crossing nothing new.
    const sig60 = await contribute(c, await newContributor(), MAX_PER_CONTRIBUTOR);
    const sig70 = await contribute(c, await newContributor(), MAX_PER_CONTRIBUTOR);
    assert.strictEqual(await flagsOf(c), 0b011, "70% still has only two bits");
    assert.lengthOf(await milestoneEventsOf(sig60), 0, "60% emits nothing");
    assert.lengthOf(await milestoneEventsOf(sig70), 0, "70% emits nothing");

    // The eighth lands at 80%, jumping over the 75% mark.
    const sig75 = await contribute(c, await newContributor(), MAX_PER_CONTRIBUTOR);
    assert.strictEqual(await flagsOf(c), 0b111, "80% must have fired all three");
    assert.lengthOf(
      await milestoneEventsOf(sig75),
      1,
      "crossing 75% emits exactly one event"
    );
  });

  // ------------------------------------------------------------------
  // The abuse case - a passed milestone can never be re-fired
  // ------------------------------------------------------------------

  it("never re-fires a milestone once the total has passed it", async () => {
    const c = await openCampaign();

    // Six fresh contributors of 3M each: 9M fires 25%, 15M fires 50%, and the
    // final contribution lands at 18M (60%) - past both marks again. No single
    // wallet can push across a mark by itself (10% cap), hence six backers.
    const contributions = [
      MAX_PER_CONTRIBUTOR, // -> 3M   (10%)
      MAX_PER_CONTRIBUTOR, // -> 6M   (20%)
      MAX_PER_CONTRIBUTOR, // -> 9M   (30%, fires 25%)
      MAX_PER_CONTRIBUTOR, // -> 12M  (40%)
      MAX_PER_CONTRIBUTOR, // -> 15M  (50%, fires 50%)
      MAX_PER_CONTRIBUTOR, // -> 18M  (60%, past both again)
    ];

    let sig: string | undefined;
    for (const amount of contributions) {
      sig = await contribute(c, await newContributor(), amount);
    }

    // Both expected marks fired; the abusive last step emits nothing new.
    assert.strictEqual(await flagsOf(c), 0b011, "25% and 50% fired once");
    assert.lengthOf(
      await milestoneEventsOf(sig!),
      0,
      "a contribution past fired marks emits nothing"
    );
  });
});