import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { Clock, ProgramTestContext } from "solana-bankrun";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert, AssertionError } from "chai";

/**
 * Milestones: `contribute` sets bit i of `milestones_fired` and emits
 * MilestoneReached the first time the total reaches quarter i + 1 of the
 * target. `assert_milestone(quarter)` fails unless that bit is set.
 *
 * Runs on bankrun for two reasons: one test has to move the clock past the
 * deadline to refund, and bankrun hands back each transaction's logs, which is
 * where the event is.
 */
describe("fundraiser — milestones (bankrun)", () => {
  // Quarters of 40 tokens are 10, 20 and 30 tokens. The per-contributor cap is
  // 10% of the target, 4 tokens, so each quarter takes several contributors.
  const TARGET = 40_000_000;
  const DURATION_DAYS = 7;
  const DAY = 86_400n;
  const SLOTS_PER_DAY = 216_000n; // 400ms slots

  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Fundraiser>;
  let payer: anchor.web3.Keypair;
  let events: anchor.EventParser;

  before(async () => {
    context = await startAnchor("", [], []);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);

    const idl = require("../target/idl/fundraiser.json");
    program = new anchor.Program<Fundraiser>(idl, provider);
    payer = context.payer;
    events = new anchor.EventParser(program.programId, program.coder);
  });

  /** Signs with the payer plus any extras, runs it, and returns its logs. */
  const send = async (
    ixs: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Keypair[] = []
  ): Promise<string[]> => {
    const tx = new anchor.web3.Transaction();
    const [blockhash] = await context.banksClient.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(...ixs);
    tx.sign(payer, ...signers);
    const meta = await context.banksClient.processTransaction(tx);
    return meta.logMessages;
  };

  /** Moves the bank forward by `days`. See time-window-bankrun.ts for why both calls. */
  const advanceDays = async (days: bigint) => {
    const before = await context.banksClient.getClock();
    context.warpToSlot(before.slot + days * SLOTS_PER_DAY);

    const clock = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        before.unixTimestamp + days * DAY
      )
    );
  };

  /** Rethrows chai's AssertionError so an `assert.fail` in a `try` is not swallowed. */
  const errorCodeOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;

    const text = `${err?.message ?? ""} ${JSON.stringify(err?.logs ?? [])}`;

    const byName = text.match(/Error Code: (\w+)/);
    if (byName) return byName[1];

    const byNumber = text.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (byNumber) {
      const code = parseInt(byNumber[1], 16);
      const known = (program.idl.errors ?? []).find((e: any) => e.code === code);
      if (known) return known.name;
      return `custom error ${code}`;
    }

    return text.slice(0, 300);
  };

  const assertErrorIs = (err: any, expected: string, why: string) => {
    const actual = errorCodeOf(err);
    assert.strictEqual(
      actual.toLowerCase(),
      expected.toLowerCase(),
      `${why} (expected ${expected}, got ${actual})`
    );
  };

  /** The MilestoneReached events in a transaction's logs. */
  const milestonesIn = (logs: string[]) =>
    [...events.parseLogs(logs)]
      .filter((e) => e.name.toLowerCase() === "milestonereached")
      .map((e) => ({
        fundraiser: (e.data.fundraiser as anchor.web3.PublicKey).toBase58(),
        quarter: e.data.quarter as number,
        amount: (e.data.amount as anchor.BN).toString(),
      }));

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
    // The most one contributor may give: 10% of the target, rounded down as
    // `contribute` rounds it.
    cap: number;
  };

  /** A fresh maker, mint and seven day fundraiser, so each test is independent. */
  const openCampaign = async (target = TARGET): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;

    const rent = await context.banksClient.getRent();
    await send(
      [
        anchor.web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: maker.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        }),
        anchor.web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
      ],
      [mintKeypair]
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await send(
      [
        await program.methods
          .initialize(new anchor.BN(target), DURATION_DAYS)
          .accountsPartial({
            maker: maker.publicKey,
            mintToRaise: mint,
            fundraiser,
            vault,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [maker]
    );

    return { maker, mint, fundraiser, vault, cap: Math.floor(target / 10) };
  };

  /** A new wallet with SOL for rent and a token account holding 10 tokens. */
  const newContributor = async (c: Campaign) => {
    const keypair = anchor.web3.Keypair.generate();
    const ata = getAssociatedTokenAddressSync(c.mint, keypair.publicKey);
    await send([
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: keypair.publicKey,
        lamports: anchor.web3.LAMPORTS_PER_SOL / 10,
      }),
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, keypair.publicKey, c.mint),
      createMintToInstruction(c.mint, ata, payer.publicKey, 10_000_000),
    ]);
    const [account] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), c.fundraiser.toBuffer(), keypair.publicKey.toBuffer()],
      program.programId
    );
    return { keypair, ata, account };
  };

  type Backer = Awaited<ReturnType<typeof newContributor>>;

  const contribute = async (c: Campaign, who: Backer, amount: number) =>
    send(
      [
        await program.methods
          .contribute(new anchor.BN(amount))
          .accountsPartial({
            contributor: who.keypair.publicKey,
            mintToRaise: c.mint,
            fundraiser: c.fundraiser,
            contributorAccount: who.account,
            contributorAta: who.ata,
            vault: c.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
      ],
      [who.keypair]
    );

  /**
   * Contributes `total` spread over as many new contributors as the 10% cap
   * needs, and returns every MilestoneReached event those transactions emitted.
   */
  const raise = async (c: Campaign, total: number) => {
    const backers: Backer[] = [];
    const fired: ReturnType<typeof milestonesIn> = [];
    let left = total;
    while (left > 0) {
      const amount = Math.min(c.cap, left);
      const who = await newContributor(c);
      fired.push(...milestonesIn(await contribute(c, who, amount)));
      backers.push(who);
      left -= amount;
    }
    return { backers, fired };
  };

  const refund = async (c: Campaign, who: Backer) =>
    send(
      [
        await program.methods
          .refund()
          .accountsPartial({
            contributor: who.keypair.publicKey,
            maker: c.maker.publicKey,
            mintToRaise: c.mint,
            fundraiser: c.fundraiser,
            contributorAccount: who.account,
            contributorAta: who.ata,
            vault: c.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
      ],
      [who.keypair]
    );

  const assertMilestone = async (c: Campaign, quarter: number) =>
    send([
      await program.methods
        .assertMilestone(quarter)
        .accountsPartial({ fundraiser: c.fundraiser })
        .instruction(),
    ]);

  const firedBits = async (c: Campaign) =>
    (await program.account.fundraiser.fetch(c.fundraiser)).milestonesFired;

  // ------------------------------------------------------------------
  // Happy path
  // ------------------------------------------------------------------

  it("fires each quarter exactly once as the total crosses it", async () => {
    const c = await openCampaign();

    // 0 → 10 tokens: quarter 1.
    const first = await raise(c, 10_000_000);
    assert.strictEqual(await firedBits(c), 0b001, "only quarter 1 should be fired");
    assert.deepStrictEqual(
      first.fired,
      [{ fundraiser: c.fundraiser.toBase58(), quarter: 1, amount: "10000000" }],
      "one MilestoneReached for quarter 1, carrying the total that reached it"
    );

    // 10 → 20 tokens: quarter 2, and quarter 1 does not fire again.
    const second = await raise(c, 10_000_000);
    assert.strictEqual(await firedBits(c), 0b011, "quarters 1 and 2 should be fired");
    assert.deepStrictEqual(second.fired.map((e) => e.quarter), [2]);

    // 20 → 30 tokens: quarter 3.
    const third = await raise(c, 10_000_000);
    assert.strictEqual(await firedBits(c), 0b111, "all three quarters should be fired");
    assert.deepStrictEqual(third.fired.map((e) => e.quarter), [3]);

    // And the chain now vouches for every one of them.
    for (const quarter of [1, 2, 3]) {
      try {
        await assertMilestone(c, quarter);
      } catch (err) {
        assert.fail(`assert_milestone(${quarter}) should pass, got ${errorCodeOf(err)}`);
      }
    }
  });

  // ------------------------------------------------------------------
  // Boundary
  // ------------------------------------------------------------------

  it("does not fire one raw unit below a quarter", async () => {
    const c = await openCampaign();

    const { fired } = await raise(c, 10_000_000 - 1);

    assert.strictEqual(await firedBits(c), 0, "no quarter should be fired at 9.999999 tokens");
    assert.lengthOf(fired, 0, "no MilestoneReached should have been emitted");

    try {
      await assertMilestone(c, 1);
      assert.fail("assert_milestone(1) must fail one unit short of the quarter");
    } catch (err) {
      assertErrorIs(err, "MilestoneNotReached", "quarter 1 has not been reached");
    }
  });

  it("fires exactly on a quarter", async () => {
    const c = await openCampaign();

    const { fired } = await raise(c, 10_000_000);

    assert.strictEqual(await firedBits(c), 0b001, "quarter 1 fires at exactly 10 tokens");
    assert.deepStrictEqual(fired.map((e) => e.quarter), [1]);
  });

  it("does not round a quarter down when the target is not divisible by four", async () => {
    // A quarter of 30_000_001 is 7_500_000.25. Integer division would put the
    // threshold at 7_500_000 and fire a quarter of a unit early.
    const c = await openCampaign(30_000_001);

    await raise(c, 7_500_000);
    assert.strictEqual(await firedBits(c), 0, "7_500_000 is still short of a quarter");

    // One more contributor tops it up past 7_500_000.25.
    const { fired } = await raise(c, 1_000_000);
    assert.strictEqual(await firedBits(c), 0b001, "8_500_000 is past a quarter");
    assert.deepStrictEqual(fired.map((e) => e.quarter), [1]);
  });

  // ------------------------------------------------------------------
  // Abuse
  // ------------------------------------------------------------------

  it("does not re-fire a quarter on later contributions", async () => {
    const c = await openCampaign();
    const { backers } = await raise(c, 10_000_000);
    assert.strictEqual(await firedBits(c), 0b001);

    // The condition "total >= a quarter" is still true for every contribution
    // after this one. Only the flag stops the event from firing again.
    const again = milestonesIn(await contribute(c, backers[2], 1_000_000));

    assert.lengthOf(again, 0, "quarter 1 must not fire a second time");
    assert.strictEqual(await firedBits(c), 0b001, "the bitmask must be unchanged");
  });

  it("assert_milestone refuses quarters that do not exist", async () => {
    const c = await openCampaign();
    await raise(c, 30_000_000); // every real quarter is fired

    // Even with all three bits set, 0 and 4 must not read some other bit.
    for (const quarter of [0, 4, 255]) {
      try {
        await assertMilestone(c, quarter);
        assert.fail(`assert_milestone(${quarter}) must be refused`);
      } catch (err) {
        assertErrorIs(err, "InvalidMilestone", `quarter ${quarter} is not a milestone`);
      }
    }
  });

  it("keeps a quarter fired after refunds empty the vault", async () => {
    const c = await openCampaign();
    const { backers } = await raise(c, 10_000_000);
    assert.strictEqual(await firedBits(c), 0b001);

    // The campaign misses its target, the window closes, everyone refunds.
    await advanceDays(8n);
    for (const who of backers) {
      await refund(c, who);
    }

    const fundraiser = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(fundraiser.currentAmount.toString(), "0", "every token was refunded");
    assert.strictEqual(
      fundraiser.milestonesFired,
      0b001,
      "a milestone is history: refunds lower the total but do not un-fire it"
    );

    try {
      await assertMilestone(c, 1);
    } catch (err) {
      assert.fail(`quarter 1 was reached once, so assert_milestone(1) should pass, got ${errorCodeOf(err)}`);
    }

    // And nothing can push the total back up to fire anything again.
    const late = await newContributor(c);
    try {
      await contribute(c, late, 1_000_000);
      assert.fail("contributions must be refused after the deadline");
    } catch (err) {
      assertErrorIs(err, "FundraiserEnded", "the window has closed");
    }
  });
});
