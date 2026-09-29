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
import { assert, AssertionError } from "chai";

describe("fundraiser — milestones feature", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;
  const eventParser = new anchor.EventParser(program.programId, program.coder);

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  const errorCodeOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;
    const text = `${err?.message ?? ""} ${JSON.stringify(err?.logs ?? [])}`;
    const match = text.match(/Error Code: (\w+)/);
    return match ? match[1] : text.slice(0, 300);
  };

  type MilestoneEvent = {
    fundraiser: anchor.web3.PublicKey;
    quarter: number;
    amount: anchor.BN;
  };

  const getEventsForTx = async (txSig: string): Promise<MilestoneEvent[]> => {
    const tx = await provider.connection.getTransaction(txSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.logMessages) return [];
    const events: MilestoneEvent[] = [];
    for (const event of eventParser.parseLogs(tx.meta.logMessages)) {
      if (event.name === "milestoneReached") {
        events.push(event.data as MilestoneEvent);
      }
    }
    return events;
  };

  /**
   * Helper to set up a new campaign with a dedicated mint.
   * target is in raw token units (with 6 decimals).
   */
  const setupCampaign = async (targetRaw: number, durationDays: number = 7) => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
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
      .initialize(new anchor.BN(targetRaw), durationDays)
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

  /**
   * Helper to create a funded contributor with their token ATA.
   */
  const createContributor = async (mint: anchor.web3.PublicKey, tokensToMint: number) => {
    const keypair = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(keypair.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const ata = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        keypair.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      ata,
      provider.publicKey,
      tokensToMint
    );

    return { keypair, ata };
  };

  const contributeAs = async (
    campaign: { fundraiser: anchor.web3.PublicKey; mint: anchor.web3.PublicKey; vault: anchor.web3.PublicKey },
    contributor: { keypair: anchor.web3.Keypair; ata: anchor.web3.PublicKey },
    amountRaw: number
  ): Promise<string> => {
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), campaign.fundraiser.toBuffer(), contributor.keypair.publicKey.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .contribute(new anchor.BN(amountRaw))
      .accountsPartial({
        contributor: contributor.keypair.publicKey,
        mintToRaise: campaign.mint,
        fundraiser: campaign.fundraiser,
        contributorAccount,
        contributorAta: contributor.ata,
        vault: campaign.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor.keypair])
      .rpc();

    await confirm(tx);
    return tx;
  };

  // ------------------------------------------------------------------
  // Test 1: Initial state has 0 milestones fired
  // ------------------------------------------------------------------
  it("initializes campaign with milestones_fired = 0", async () => {
    const TARGET = 40_000_000; // 40 tokens
    const campaign = await setupCampaign(TARGET);

    const account = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(
      account.milestonesFired,
      0,
      "milestones_fired should be initialized to 0"
    );
  });

  // ------------------------------------------------------------------
  // Test 2: Exact boundary test — 1 unit below 25% does NOT fire; reaching it DOES
  // ------------------------------------------------------------------
  it("boundary test: does not fire at 24.9999975%, fires at 25%", async () => {
    const TARGET = 40_000_000; // 40 tokens. 25% is exactly 10_000_000.
    // Max 10% per contributor = 4_000_000
    const campaign = await setupCampaign(TARGET);

    // Contributor 1: 4,000,000 (total: 4,000,000 = 10%)
    const c1 = await createContributor(campaign.mint, 5_000_000);
    const tx1 = await contributeAs(campaign, c1, 4_000_000);
    const events1 = await getEventsForTx(tx1);

    let state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(state.milestonesFired, 0, "no milestone at 10%");
    assert.strictEqual(events1.length, 0, "no event at 10%");

    // Contributor 2: 4,000,000 (total: 8,000,000 = 20%)
    const c2 = await createContributor(campaign.mint, 5_000_000);
    const tx2 = await contributeAs(campaign, c2, 4_000_000);
    const events2 = await getEventsForTx(tx2);

    state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(state.milestonesFired, 0, "no milestone at 20%");
    assert.strictEqual(events2.length, 0, "no event at 20%");

    // Contributor 3: 1,999,999 (total: 9,999,999 = 24.9999975%) — EXACT BOUNDARY (1 unit below 25%)
    const c3 = await createContributor(campaign.mint, 5_000_000);
    const tx3 = await contributeAs(campaign, c3, 1_999_999);
    const events3 = await getEventsForTx(tx3);

    state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(
      state.milestonesFired,
      0,
      "boundary check: exactly 1 unit below 25% must NOT fire milestone"
    );
    assert.strictEqual(events3.length, 0, "no event emitted 1 unit below 25%");

    // Contributor 4: 1,000,001 (total: 11,000,000 = 27.5%) — CROSSES 25%
    const c4 = await createContributor(campaign.mint, 5_000_000);
    const tx4 = await contributeAs(campaign, c4, 1_000_001);
    const events4 = await getEventsForTx(tx4);

    state = await program.account.fundraiser.fetch(campaign.fundraiser);
    // Bit 0 must be set (1)
    assert.strictEqual(
      state.milestonesFired,
      1,
      "milestones_fired should be 1 (bit 0 set) after crossing 25%"
    );

    // Verify event was emitted for quarter 1
    assert.strictEqual(events4.length, 1, "exactly 1 milestone event emitted");
    assert.strictEqual(events4[0].quarter, 1, "event should report quarter 1");
    assert.strictEqual(
      events4[0].amount.toString(),
      "11000000",
      "event should report current vault amount at trigger"
    );
  });

  // ------------------------------------------------------------------
  // Test 3: Happy path for all 3 milestones (25%, 50%, 75%) and idempotency
  // ------------------------------------------------------------------
  it("happy path & idempotency: fires at 25%, 50%, 75%, and never re-fires", async () => {
    const TARGET = 40_000_000; // 40 tokens: 25% = 10M, 50% = 20M, 75% = 30M
    const campaign = await setupCampaign(TARGET);

    // Contributors 1-3 to reach 10,000,000 (25% milestone)
    const c1 = await createContributor(campaign.mint, 4_000_000);
    await contributeAs(campaign, c1, 4_000_000);
    const c2 = await createContributor(campaign.mint, 4_000_000);
    await contributeAs(campaign, c2, 4_000_000);
    const c3 = await createContributor(campaign.mint, 4_000_000);
    const tx25 = await contributeAs(campaign, c3, 2_000_000);

    // Vault is at 10,000,000 (25%)
    let state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(state.milestonesFired, 1, "milestonesFired = 1 (bit 0) at 25%");
    const events25 = await getEventsForTx(tx25);
    assert.strictEqual(events25.length, 1, "1 event emitted for 25%");
    assert.strictEqual(events25[0].quarter, 1);

    // Additional contribution between 25% and 50%: should NOT re-fire 25%
    const txMid = await contributeAs(campaign, c3, 2_000_000); // c3 now contributed 4M total; vault = 12M
    state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(state.milestonesFired, 1, "milestonesFired stays 1 between milestones");
    const eventsMid = await getEventsForTx(txMid);
    assert.strictEqual(eventsMid.length, 0, "no duplicate event between milestones");

    // Contributors 4 and 5 to cross 20,000,000 (50% milestone)
    const c4 = await createContributor(campaign.mint, 4_000_000);
    await contributeAs(campaign, c4, 4_000_000); // vault = 16M
    const c5 = await createContributor(campaign.mint, 4_000_000);
    const tx50 = await contributeAs(campaign, c5, 4_000_000); // vault = 20M (50%)

    state = await program.account.fundraiser.fetch(campaign.fundraiser);
    // Bits 0 and 1 must be set: 1 | 2 = 3
    assert.strictEqual(state.milestonesFired, 3, "milestonesFired = 3 (bits 0 & 1) at 50%");
    const events50 = await getEventsForTx(tx50);
    assert.strictEqual(events50.length, 1, "1 event emitted for 50%");
    assert.strictEqual(events50[0].quarter, 2);

    // Contributors 6, 7, and 8 to cross 30,000,000 (75% milestone)
    const c6 = await createContributor(campaign.mint, 4_000_000);
    await contributeAs(campaign, c6, 4_000_000); // vault = 24M
    const c7 = await createContributor(campaign.mint, 4_000_000);
    await contributeAs(campaign, c7, 4_000_000); // vault = 28M
    const c8 = await createContributor(campaign.mint, 4_000_000);
    const tx75 = await contributeAs(campaign, c8, 2_000_000); // vault = 30M (75%)

    state = await program.account.fundraiser.fetch(campaign.fundraiser);
    // Bits 0, 1, and 2 must be set: 1 | 2 | 4 = 7
    assert.strictEqual(state.milestonesFired, 7, "milestonesFired = 7 (bits 0, 1 & 2) at 75%");
    const events75 = await getEventsForTx(tx75);
    assert.strictEqual(events75.length, 1, "1 event emitted for 75%");
    assert.strictEqual(events75[0].quarter, 3);

    // Idempotency check: further contributions past 75% do NOT fire anything extra
    const txPast = await contributeAs(campaign, c8, 2_000_000); // vault = 32M (80%)
    state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(state.milestonesFired, 7, "milestonesFired remains 7");
    const eventsPast = await getEventsForTx(txPast);
    assert.strictEqual(eventsPast.length, 0, "no extra event emitted beyond 75%");
  });

  // ------------------------------------------------------------------
  // Test 4: Abuse / Error cases: caps and minimums properly enforced
  // ------------------------------------------------------------------
  it("enforces contribution bounds and rejected transactions do not alter milestone flags", async () => {
    const TARGET = 40_000_000;
    const campaign = await setupCampaign(TARGET);
    const c = await createContributor(campaign.mint, 10_000_000);

    // Try contributing less than 1 whole token (999,999)
    try {
      await contributeAs(campaign, c, 999_999);
      assert.fail("contribution below 1 token should fail");
    } catch (err) {
      assert.strictEqual(errorCodeOf(err), "ContributionTooSmall");
    }

    // Try contributing more than 10% of target (4,000,001)
    try {
      await contributeAs(campaign, c, 4_000_001);
      assert.fail("contribution above 10% of target should fail");
    } catch (err) {
      assert.strictEqual(errorCodeOf(err), "ContributionTooBig");
    }

    // Verify milestone state is unaltered
    const state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(state.milestonesFired, 0, "failed transactions must not alter milestones_fired");
  });
});
