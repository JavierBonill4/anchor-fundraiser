import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { Clock, ProgramTestContext } from "solana-bankrun";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction, createInitializeMint2Instruction,
  createMintToInstruction, getAssociatedTokenAddressSync, unpackAccount,
} from "@solana/spl-token";
import { assert, AssertionError } from "chai";
import { fundraiserPda, contributorPda } from "./pda";

/**
 * The raise clears like a book build.
 *
 * A contribution is a bid, not a purchase. There is no per-contributor cap: bid
 * whatever you like, and if the raise is oversubscribed everyone is filled in
 * proportion and takes the rest back.
 *
 *     filled_i = ceil(amount_to_raise * bid_i / settled_total)
 *
 * The maker is paid exactly the target, never the vault. Which is the whole
 * reason this feature forces the program's oldest bug out into the open: the
 * settlement guard used to read `vault.amount`, an ordinary ATA anyone can
 * transfer into. As a pass/fail test that was merely wrong. As the denominator
 * of everyone's fill it would be theft.
 */
describe("fundraiser — oversubscription clears pro rata", () => {
  const TARGET = 10_000_000;   // 10 tokens at 6 decimals
  const BID = 7_000_000;       // 70% of target each — the old cap refused 10%+
  const DAY = 86_400n;
  const SLOTS_PER_DAY = 216_000n;

  let context: ProgramTestContext;
  let program: Program<Fundraiser>;
  let payer: anchor.web3.Keypair;

  beforeEach(async () => {
    context = await startAnchor("", [], []);
    const provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    program = new anchor.Program<Fundraiser>(require("../target/idl/fundraiser.json"), provider);
    payer = context.payer;
  });

  const send = async (ixs: anchor.web3.TransactionInstruction[], signers: anchor.web3.Keypair[] = []) => {
    const tx = new anchor.web3.Transaction();
    const [blockhash] = await context.banksClient.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(...ixs);
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
  };

  const textOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    return `${err?.message ?? err} ${JSON.stringify(err?.logs ?? [])}`;
  };

  const errorCodeOf = (err: any): string => {
    const text = textOf(err);
    const byName = text.match(/Error Code: (\w+)/);
    if (byName) return byName[1];
    const byNumber = text.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (byNumber) {
      const code = parseInt(byNumber[1], 16);
      const known = (program.idl.errors ?? []).find((e: any) => e.code === code);
      if (known) return known.name;
      return `custom error ${code}`;
    }
    return text.slice(0, 200);
  };

  const assertErrorIs = (err: any, expected: string, why: string) => {
    const text = textOf(err);
    assert.notMatch(text, /already processed|AlreadyProcessed|blockhash not found/i,
      `${why} — refused as a duplicate, not on its merits: ${text.slice(0, 200)}`);
    const actual = errorCodeOf(err);
    assert.strictEqual(actual.toLowerCase(), expected.toLowerCase(),
      `${why} (expected ${expected}, got ${actual})`);
  };

  const advanceDays = async (days: bigint) => {
    const before = await context.banksClient.getClock();
    context.warpToSlot(before.slot + days * SLOTS_PER_DAY);
    const clock = await context.banksClient.getClock();
    context.setClock(new Clock(clock.slot, clock.epochStartTimestamp, clock.epoch,
      clock.leaderScheduleEpoch, before.unixTimestamp + days * DAY));
  };

  const tokenBalance = async (address: anchor.web3.PublicKey): Promise<bigint> => {
    const account = await context.banksClient.getAccount(address);
    if (!account) return 0n;
    return unpackAccount(address, {
      ...account, data: Buffer.from(account.data),
      owner: new anchor.web3.PublicKey(account.owner),
    } as any).amount;
  };

  type Bidder = { kp: anchor.web3.Keypair; ata: anchor.web3.PublicKey };

  /** A maker, a mint, and `n` funded bidders each holding 10x the bid size. */
  const setup = async (n: number) => {
    const maker = anchor.web3.Keypair.generate();
    const mintKp = anchor.web3.Keypair.generate();
    const mint = mintKp.publicKey;
    const rent = await context.banksClient.getRent();

    await send([
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey, toPubkey: maker.publicKey,
        lamports: 2 * anchor.web3.LAMPORTS_PER_SOL,
      }),
      anchor.web3.SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: mint, space: MINT_SIZE,
        lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))), programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
    ], [mintKp]);

    const bidders: Bidder[] = [];
    for (let i = 0; i < n; i++) {
      const kp = anchor.web3.Keypair.generate();
      const ata = getAssociatedTokenAddressSync(mint, kp.publicKey);
      await send([
        anchor.web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey, toPubkey: kp.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        }),
        createAssociatedTokenAccountInstruction(payer.publicKey, ata, kp.publicKey, mint),
        createMintToInstruction(mint, ata, payer.publicKey, 10 * TARGET),
      ]);
      bidders.push({ kp, ata });
    }
    return { maker, mint, bidders };
  };

  const open = async (maker: anchor.web3.Keypair, mint: anchor.web3.PublicKey, id: number, days: number) => {
    const fundraiser = fundraiserPda(program.programId, maker.publicKey, id);
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    await send([await program.methods.initialize(new anchor.BN(id), new anchor.BN(TARGET), days)
      .accountsPartial({
        maker: maker.publicKey, mintToRaise: mint, fundraiser, vault,
        systemProgram: anchor.web3.SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).instruction()], [maker]);
    const { timeStarted } = await program.account.fundraiser.fetch(fundraiser);
    return {
      maker, mint, id, fundraiser, vault, timeStarted,
      makerAta: getAssociatedTokenAddressSync(mint, maker.publicKey),
    };
  };
  type Campaign = Awaited<ReturnType<typeof open>>;

  const seat = (c: Campaign, b: Bidder) =>
    contributorPda(program.programId, c.fundraiser, b.kp.publicKey, c.timeStarted);

  const bid = async (c: Campaign, b: Bidder, amount: number) =>
    send([await program.methods.contribute(new anchor.BN(amount)).accountsPartial({
      contributor: b.kp.publicKey, mintToRaise: c.mint, fundraiser: c.fundraiser,
      contributorAccount: seat(c, b), contributorAta: b.ata, vault: c.vault,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId,
    }).instruction()], [b.kp]);

  const settle = async (c: Campaign) =>
    send([await program.methods.checkContributions().accountsPartial({
      maker: c.maker.publicKey, mintToRaise: c.mint, fundraiser: c.fundraiser, vault: c.vault,
      makerAta: c.makerAta, tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).instruction()], [c.maker]);

  const claim = async (c: Campaign, b: Bidder) =>
    send([await program.methods.claimExcess().accountsPartial({
      contributor: b.kp.publicKey, maker: c.maker.publicKey, mintToRaise: c.mint,
      fundraiser: c.fundraiser, contributorAccount: seat(c, b), contributorAta: b.ata,
      vault: c.vault, tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).instruction()], [b.kp]);

  const refund = async (c: Campaign, b: Bidder) =>
    send([await program.methods.refund().accountsPartial({
      contributor: b.kp.publicKey, maker: c.maker.publicKey, mintToRaise: c.mint,
      fundraiser: c.fundraiser, contributorAccount: seat(c, b), contributorAta: b.ata,
      vault: c.vault, tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).instruction()], [b.kp]);

  const closeCampaign = async (c: Campaign) =>
    send([await program.methods.closeCampaign().accountsPartial({
      caller: payer.publicKey, maker: c.maker.publicKey, mintToRaise: c.mint,
      fundraiser: c.fundraiser, vault: c.vault, makerAta: c.makerAta,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    }).instruction()]);

  // ------------------------------------------------------------------
  // The happy path, with the arithmetic written out
  // ------------------------------------------------------------------

  it("fills every bidder pro rata and pays the maker exactly the target", async () => {
    const { maker, mint, bidders } = await setup(3);
    const c = await open(maker, mint, 1, 7);

    for (const b of bidders) await bid(c, b, BID);

    // 3 x 7,000,000 against a 10,000,000 target: 2.1x oversubscribed.
    const state = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(state.currentAmount.toString(), String(3 * BID), "the book holds every bid");
    assert.strictEqual(await tokenBalance(c.vault), BigInt(3 * BID), "and so does the vault");

    await advanceDays(8n);
    await settle(c);

    assert.strictEqual(await tokenBalance(c.makerAta), BigInt(TARGET),
      "the maker is paid the target, not the vault");
    assert.strictEqual(await tokenBalance(c.vault), BigInt(3 * BID - TARGET),
      "the oversubscription stays behind for the bidders");

    // filled = ceil(10_000_000 * 7_000_000 / 21_000_000) = ceil(3_333_333.33) = 3_333_334
    // excess = 7_000_000 - 3_333_334                                          = 3_666_666
    const EXPECTED_EXCESS = 3_666_666n;
    for (const b of bidders) {
      const before = await tokenBalance(b.ata);
      await claim(c, b);
      assert.strictEqual((await tokenBalance(b.ata)) - before, EXPECTED_EXCESS,
        "each bidder takes back exactly the unfilled part of their bid");
    }

    // Rounding up means the fills sum to 10,000,002 — two units more than the
    // target — so two units of dust are left rather than two units missing.
    assert.strictEqual(await tokenBalance(c.vault), 2n, "solvent, with dust left over");

    const after = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(after.currentAmount.toString(), "0", "the book is empty");
  });

  it("is solvent: nobody's claim can fail for want of tokens", async () => {
    const { maker, mint, bidders } = await setup(3);
    const c = await open(maker, mint, 1, 7);
    for (const b of bidders) await bid(c, b, BID);
    await advanceDays(8n);
    await settle(c);

    // The last claimer is where floor-rounding would break: the fills would sum
    // to less than the target, the claims to more than the vault holds.
    for (const b of bidders) await claim(c, b);

    await closeCampaign(c);
    assert.isNull(await context.banksClient.getAccount(c.vault), "vault closed");
    assert.isNull(await context.banksClient.getAccount(c.fundraiser), "fundraiser closed");
    assert.strictEqual(await tokenBalance(c.makerAta), BigInt(TARGET) + 2n,
      "the maker gets the target plus the swept dust, and not a unit more");
  });

  // ------------------------------------------------------------------
  // The boundary
  // ------------------------------------------------------------------

  it("fills exactly, with nothing to claim, when the book lands on the target", async () => {
    const { maker, mint, bidders } = await setup(2);
    const c = await open(maker, mint, 1, 7);
    await bid(c, bidders[0], TARGET / 2);
    await bid(c, bidders[1], TARGET / 2);

    await advanceDays(8n);
    await settle(c);

    for (const b of bidders) {
      const before = await tokenBalance(b.ata);
      await claim(c, b);
      assert.strictEqual((await tokenBalance(b.ata)) - before, 0n,
        "a fully filled bid claims nothing, and still clears itself off the book");
    }
    assert.strictEqual(await tokenBalance(c.vault), 0n, "no dust when it divides exactly");
  });

  it("refuses to settle one unit under the target, and settles exactly on it", async () => {
    const { maker, mint, bidders } = await setup(2);

    // Two campaigns, one either side of the line. They cannot be the same
    // campaign: topping up after the deadline is refused by design, which is the
    // point of shutting the book.
    const short = await open(maker, mint, 1, 7);
    await bid(short, bidders[0], TARGET - 1);

    const exact = await open(maker, mint, 2, 7);
    await bid(exact, bidders[1], TARGET);

    await advanceDays(8n);

    try {
      await settle(short);
      assert.fail("a book one unit short of the target must not settle");
    } catch (err) {
      assertErrorIs(err, "TargetNotMet", "the book is one unit short");
    }
    assert.strictEqual(await tokenBalance(short.makerAta), 0n, "and the maker is paid nothing");

    await settle(exact);
    assert.strictEqual(await tokenBalance(exact.makerAta), BigInt(TARGET),
      "landing exactly on the target settles");
  });

  it("refuses to settle before the deadline", async () => {
    const { maker, mint, bidders } = await setup(2);
    const c = await open(maker, mint, 1, 7);
    for (const b of bidders) await bid(c, b, BID);

    // Covered on day 0 — but settling now would freeze out every later bid and
    // fix the fill ratio in the early bidders' favour.
    try {
      await settle(c);
      assert.fail("settlement before the deadline must be refused");
    } catch (err) {
      assertErrorIs(err, "FundraiserNotEnded", "the book is still open");
    }
  });

  // ------------------------------------------------------------------
  // The bug this feature was chosen to expose
  // ------------------------------------------------------------------

  it("does not count tokens transferred straight into the vault", async () => {
    const { maker, mint } = await setup(0);
    const c = await open(maker, mint, 1, 7);

    // Anyone can do this: the vault is an ordinary ATA.
    await send([createMintToInstruction(mint, c.vault, payer.publicKey, TARGET * 5)]);
    assert.strictEqual(await tokenBalance(c.vault), BigInt(TARGET * 5), "the vault is well over target");

    await advanceDays(8n);
    try {
      await settle(c);
      assert.fail("a vault stuffed by a stranger must not settle a campaign with an empty book");
    } catch (err) {
      assertErrorIs(err, "TargetNotMet",
        "the guard reads the book, so a vault transfer moves nothing that matters");
    }
  });

  it("cannot be diluted by a stranger stuffing the vault after the book shuts", async () => {
    const { maker, mint, bidders } = await setup(2);
    const c = await open(maker, mint, 1, 7);
    await bid(c, bidders[0], BID);
    await bid(c, bidders[1], BID);
    await advanceDays(8n);
    await settle(c);

    // If the fill denominator were `vault.amount`, this would shrink everyone's
    // fill and leave their excess for the taking.
    await send([createMintToInstruction(mint, c.vault, payer.publicKey, TARGET * 100)]);

    // filled = ceil(10_000_000 * 7_000_000 / 14_000_000) = 5_000_000, excess = 2_000_000
    const before = await tokenBalance(bidders[0].ata);
    await claim(c, bidders[0]);
    assert.strictEqual((await tokenBalance(bidders[0].ata)) - before, 2_000_000n,
      "the fill is computed against the book as it stood when it shut");
  });

  // ------------------------------------------------------------------
  // Abuse
  // ------------------------------------------------------------------

  it("refuses a second claim", async () => {
    const { maker, mint, bidders } = await setup(2);
    const c = await open(maker, mint, 1, 7);
    for (const b of bidders) await bid(c, b, BID);
    await advanceDays(8n);
    await settle(c);
    await claim(c, bidders[0]);

    try {
      await claim(c, bidders[0]);
      assert.fail("claiming twice must be refused");
    } catch (err) {
      assert.notMatch(textOf(err), /already processed/i, "and not because it looked like a duplicate tx");
    }
  });

  it("refuses a refund once the campaign has settled", async () => {
    const { maker, mint, bidders } = await setup(2);
    const c = await open(maker, mint, 1, 7);
    for (const b of bidders) await bid(c, b, BID);
    await advanceDays(8n);
    await settle(c);

    // Both `refund` and `claim_excess` pay a contributor out of the same vault.
    // If the old `vault.amount < target` guard had survived, a settled campaign
    // whose vault had been drained by claims would look under target again and
    // hand the money out a second time.
    try {
      await refund(c, bidders[0]);
      assert.fail("a refund after settlement must be refused");
    } catch (err) {
      assertErrorIs(err, "TargetMet", "the campaign settled; the route out is claim_excess");
    }
  });

  it("accepts a bid far above the old 10% cap", async () => {
    const { maker, mint, bidders } = await setup(1);
    const c = await open(maker, mint, 1, 7);

    // 90% of the target in one go. The old rule refused anything over 10%.
    await bid(c, bidders[0], (TARGET * 9) / 10);
    const state = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(state.currentAmount.toString(), String((TARGET * 9) / 10),
      "no cap: dilution replaces rejection");
  });
});
