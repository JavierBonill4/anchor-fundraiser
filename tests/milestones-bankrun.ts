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
 * The milestone feature: bits 0, 1 and 2 of `milestones_reached` stand for the
 * 25%, 50% and 75% marks, and the maker may announce each one exactly once.
 *
 * Every test here fails without the feature — the field and the instruction do
 * not exist on the base program, so the IDL has nothing to call.
 *
 * bankrun rather than a validator: these tests only need a bank and a clock, and
 * each `it` gets its own maker, mint and campaign so they cannot leak into one
 * another.
 */
describe("fundraiser — milestones", () => {
  const DECIMALS = 6;
  const ONE_TOKEN = 1_000_000;
  // 100 tokens, so 25% is 25 tokens and a 10% cap is 10 tokens — three
  // contributions to reach the first mark, and a clean boundary to sit on.
  const TARGET = 100 * ONE_TOKEN;
  const CAP = TARGET / 10; // MAX_CONTRIBUTION_PERCENTAGE
  const DURATION_DAYS = 7;

  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Fundraiser>;
  let payer: anchor.web3.Keypair;

  before(async () => {
    context = await startAnchor("", [], []);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    const idl = require("../target/idl/fundraiser.json");
    program = new anchor.Program<Fundraiser>(idl, provider);
    payer = context.payer;
  });

  const send = async (
    ixs: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Keypair[] = []
  ) => {
    const tx = new anchor.web3.Transaction();
    const [blockhash] = await context.banksClient.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(...ixs);
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
  };

  /** See time-window-bankrun.ts: bankrun throws strings, so the code is looked
   *  up in the IDL by number when the name is not in the logs. */
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
      // Anchor's own constraint errors are not in the program IDL.
      const builtin: Record<number, string> = { 2001: "ConstraintHasOne", 2006: "ConstraintSeeds" };
      if (builtin[code]) return builtin[code];
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

  /** A fresh maker, mint, funded contributor and open campaign. */
  const openCampaign = async (target: number = TARGET) => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;

    const rent = await context.banksClient.getRent();
    const mintRent = Number(rent.minimumBalance(BigInt(MINT_SIZE)));

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
          lamports: mintRent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, DECIMALS, payer.publicKey, null),
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

    // The base program caps each contributor at 10% of the target in total, not
    // per call, so every contribution comes from a fresh, funded wallet.
    const contribute = async (amount: number) => {
      const who = anchor.web3.Keypair.generate();
      const ata = getAssociatedTokenAddressSync(mint, who.publicKey);
      const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("contributor"), fundraiser.toBuffer(), who.publicKey.toBuffer()],
        program.programId
      );
      await send([
        anchor.web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: who.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL / 10,
        }),
        createAssociatedTokenAccountInstruction(payer.publicKey, ata, who.publicKey, mint),
        createMintToInstruction(mint, ata, payer.publicKey, amount),
      ]);
      await send(
        [
          await program.methods
            .contribute(new anchor.BN(amount))
            .accountsPartial({
              contributor: who.publicKey,
              mintToRaise: mint,
              fundraiser,
              contributorAccount,
              contributorAta: ata,
              vault,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .instruction(),
        ],
        [who]
      );
      return { who, ata, contributorAccount };
    };

    const acknowledge = (index: number, who: anchor.web3.PublicKey) =>
      program.methods
        .acknowledgeMilestone(index)
        .accountsPartial({ maker: who, fundraiser })
        .instruction();

    const state = () => program.account.fundraiser.fetch(fundraiser);

    return { maker, mint, fundraiser, vault, contribute, acknowledge, state };
  };

  /** Bit i of the byte, as a boolean. */
  const bit = (mask: number, index: number) => (mask & (1 << index)) !== 0;

  // --- happy path -------------------------------------------------------
  it("records every mark a single contribution jumps past", async () => {
    const c = await openCampaign();

    // Seven contributions of 10% each: 70% of the target, which is past the
    // 25% and 50% marks but short of 75%.
    for (let i = 0; i < 7; i++) {
      await c.contribute(CAP);
    }

    let s = await c.state();
    assert.strictEqual(s.currentAmount.toNumber(), 7 * CAP, "70 tokens raised");
    assert.isTrue(bit(s.milestonesReached, 0), "25% reached");
    assert.isTrue(bit(s.milestonesReached, 1), "50% reached");
    assert.isFalse(bit(s.milestonesReached, 2), "75% not reached at 70%");

    // The trap: this one contribution takes the campaign from 70% to 80%, which
    // crosses 75% — one call, one new mark, and the two older bits untouched.
    await c.contribute(CAP);
    s = await c.state();
    assert.strictEqual(s.milestonesReached, 0b111, "all three marks recorded");
    assert.strictEqual(s.milestonesAnnounced, 0, "nothing announced yet");

    // The maker announces the first mark, once.
    await send([await c.acknowledge(0, c.maker.publicKey)], [c.maker]);
    s = await c.state();
    assert.strictEqual(s.milestonesAnnounced, 0b001, "only milestone 0 announced");
    assert.strictEqual(s.milestonesReached, 0b111, "announcing changes no reached bit");
  });

  // --- boundary ---------------------------------------------------------
  it("fires at exactly the mark, and not one unit below it", async () => {
    const c = await openCampaign();

    // 25% of 100 tokens is 25 tokens. Land one raw unit short of it. (The base
    // program refuses contributions under one whole token, so the last unit
    // has to ride along with a whole token.)
    await c.contribute(CAP);
    await c.contribute(CAP);
    await c.contribute(5 * ONE_TOKEN - 1);

    let s = await c.state();
    assert.strictEqual(s.currentAmount.toNumber(), 25 * ONE_TOKEN - 1, "one unit short");
    assert.strictEqual(s.milestonesReached, 0, "one unit below the mark must not fire");

    // A second campaign that lands on exactly 25 tokens.
    const d = await openCampaign();
    await d.contribute(CAP);
    await d.contribute(CAP);
    await d.contribute(5 * ONE_TOKEN);
    s = await d.state();
    assert.strictEqual(s.currentAmount.toNumber(), 25 * ONE_TOKEN, "exactly on the mark");
    assert.isTrue(bit(s.milestonesReached, 0), "exactly at the mark fires");
    assert.isFalse(bit(s.milestonesReached, 1), "and only that mark");
  });

  // --- abuse ------------------------------------------------------------
  it("refuses a stranger, a double announcement and a mark that has not been reached", async () => {
    const c = await openCampaign();
    await c.contribute(CAP);
    await c.contribute(CAP);
    await c.contribute(5 * ONE_TOKEN); // exactly 25%

    // A milestone that exists but has not been reached.
    try {
      await send([await c.acknowledge(1, c.maker.publicKey)], [c.maker]);
      assert.fail("announcing an unreached milestone must be refused");
    } catch (err) {
      assertErrorIs(err, "MilestoneNotReached", "50% has not been crossed");
    }

    // An index outside the table.
    try {
      await send([await c.acknowledge(7, c.maker.publicKey)], [c.maker]);
      assert.fail("an out of range index must be refused");
    } catch (err) {
      assertErrorIs(err, "InvalidMilestone", "there are only three milestones");
    }

    // A stranger who signs for themselves: the seeds are the maker's, so the
    // PDA they pass cannot both be this fundraiser and match their own key.
    const stranger = anchor.web3.Keypair.generate();
    await send([
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: stranger.publicKey,
        lamports: anchor.web3.LAMPORTS_PER_SOL,
      }),
    ]);
    try {
      await send([await c.acknowledge(0, stranger.publicKey)], [stranger]);
      assert.fail("a stranger must not be able to announce someone else's milestone");
    } catch (err) {
      // Anchor checks `seeds` (derived from the signer) before `has_one`; either
      // named constraint is a correct refusal, anything else is not.
      const code = errorCodeOf(err).toLowerCase();
      assert.oneOf(code, ["constraintseeds", "constrainthasone"],
        `the fundraiser PDA is derived from the maker (got ${code})`);
    }

    // The maker announces once...
    await send([await c.acknowledge(0, c.maker.publicKey)], [c.maker]);
    assert.strictEqual((await c.state()).milestonesAnnounced, 0b001);

    // ...and the flag is what stops the second time.
    try {
      await send([await c.acknowledge(0, c.maker.publicKey)], [c.maker]);
      assert.fail("a milestone must not be announced twice");
    } catch (err) {
      assertErrorIs(err, "MilestoneAlreadyAnnounced", "the flag byte already has bit 0 set");
    }

    assert.strictEqual(
      (await c.state()).milestonesAnnounced,
      0b001,
      "the failed attempts left the flag byte alone"
    );
  });

  // --- the trap's second half: refunds move the total back down ------------
  it("latches: a refund lowers the total but does not clear a reached bit", async () => {
    const c = await openCampaign();
    const first = await c.contribute(CAP);
    await c.contribute(CAP);
    await c.contribute(5 * ONE_TOKEN);

    let s = await c.state();
    assert.isTrue(bit(s.milestonesReached, 0), "25% reached");
    assert.strictEqual(s.currentAmount.toNumber(), 25 * ONE_TOKEN);

    // Past the seven day window and short of the target: refunds open.
    const before = await context.banksClient.getClock();
    const days = 8n;
    context.warpToSlot(before.slot + days * 216_000n);
    const now = await context.banksClient.getClock();
    context.setClock(
      new Clock(now.slot, now.epochStartTimestamp, now.epoch, now.leaderScheduleEpoch,
        before.unixTimestamp + days * 86_400n)
    );

    await send(
      [
        await program.methods
          .refund()
          .accountsPartial({
            contributor: first.who.publicKey,
            maker: c.maker.publicKey,
            mintToRaise: c.mint,
            fundraiser: c.fundraiser,
            contributorAccount: first.contributorAccount,
            contributorAta: first.ata,
            vault: c.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
      ],
      [first.who]
    );

    s = await c.state();
    assert.strictEqual(s.currentAmount.toNumber(), 15 * ONE_TOKEN,
      "the refund took the total back down to 15%, below the 25% mark");
    assert.isTrue(bit(s.milestonesReached, 0),
      "the 25% bit is a high-water mark: a refund does not clear it");
    // By design — see MILESTONES.md, "How you would attack it".
  });
});
