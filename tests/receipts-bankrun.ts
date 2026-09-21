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
  unpackAccount,
} from "@solana/spl-token";
import { assert, AssertionError } from "chai";

/**
 * The refund side of feat/contribution-receipts, on bankrun.
 *
 * These need the clock moved, which only solana-bankrun can do
 * deterministically: a refund is illegal until the window closes, and the
 * whole point is what the claimed flag does across a refund.
 *
 * The design promise being tested: the Contributor record is emptied by
 * refund but not closed, so `claimed` survives. A refunded contributor who
 * re-contributes later must NOT be able to mint a second badge — that is the
 * farming loop this feature exists to shut.
 */
describe("fundraiser — receipts across a refund (bankrun)", () => {
  const TARGET = 30_000_000;
  const CONTRIBUTION = 1_000_000;
  const DURATION_DAYS = 7;
  const DAY = 86_400n;
  const SLOTS_PER_DAY = 216_000n; // 400ms slots

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

  /** Moves the bank forward one slot — a fresh blockhash, same wall clock. */
  const nextSlot = async () => {
    const clock = await context.banksClient.getClock();
    context.warpToSlot(clock.slot + 1n);
  };

  const tokenBalance = async (address: anchor.web3.PublicKey): Promise<bigint> => {
    const account = await context.banksClient.getAccount(address);
    if (account === null) return 0n;
    return unpackAccount(address, {
      ...account!,
      data: Buffer.from(account!.data),
      owner: new anchor.web3.PublicKey(account!.owner),
    } as any).amount;
  };

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

  /** A fresh campaign with a funded contributor, all in one transaction. */
  const setupCampaign = async () => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;

    const rent = await context.banksClient.getRent();
    const mintRent = Number(rent.minimumBalance(BigInt(MINT_SIZE)));
    const contributorAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const [rewardMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward-mint"), fundraiser.toBuffer()],
      program.programId
    );
    const makerReceiptAta = getAssociatedTokenAddressSync(rewardMint, maker.publicKey);
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), payer.publicKey.toBuffer()],
      program.programId
    );
    const receiptAta = getAssociatedTokenAddressSync(rewardMint, payer.publicKey);

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
        createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
        createAssociatedTokenAccountInstruction(payer.publicKey, contributorAta, payer.publicKey, mint),
        createMintToInstruction(mint, contributorAta, payer.publicKey, 10 * CONTRIBUTION),
        await program.methods
          .initialize(new anchor.BN(TARGET), DURATION_DAYS)
          .accountsPartial({
            maker: maker.publicKey,
            mintToRaise: mint,
            fundraiser,
            rewardMint,
            makerReceiptAta,
            vault,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [maker, mintKeypair]
    );

    return { maker, mint, fundraiser, rewardMint, vault, contributorAccount, contributorAta, receiptAta };
  };

  const contributeIx = (c: Awaited<ReturnType<typeof setupCampaign>>, amount: number) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: payer.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: c.contributorAccount,
        contributorAta: c.contributorAta,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

  const refundIx = (c: Awaited<ReturnType<typeof setupCampaign>>) =>
    program.methods
      .refund()
      .accountsPartial({
        contributor: payer.publicKey,
        maker: c.maker.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: c.contributorAccount,
        contributorAta: c.contributorAta,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

  const claimIx = (c: Awaited<ReturnType<typeof setupCampaign>>) =>
    program.methods
      .claimReceipt()
      .accountsPartial({
        payer: payer.publicKey,
        contributor: payer.publicKey,
        maker: c.maker.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        rewardMint: c.rewardMint,
        contributorAccount: c.contributorAccount,
        receiptAta: c.receiptAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

  it("a refunded contributor keeps their claimed flag, and the window never reopens", async () => {
    const c = await setupCampaign();

    // Contribute on day 0.
    await send([await contributeIx(c, CONTRIBUTION)]);
    assert.strictEqual(await tokenBalance(c.vault), BigInt(CONTRIBUTION));

    // Claim the badge while the campaign is live — the normal path.
    await send([await claimIx(c)]);
    assert.strictEqual(await tokenBalance(c.receiptAta), 1n);

    // Day 8: the window has closed short of target, refund is legal.
    await advanceDays(8n);
    await send([await refundIx(c)]);
    assert.strictEqual(await tokenBalance(c.vault), 0n, "money back in the contributor's hands");

    // The record survives the refund with amount zeroed and claimed still set:
    // the flag the claim set does not die with the contribution.
    const record = await program.account.contributor.fetch(c.contributorAccount);
    assert.strictEqual(record.amount.toString(), "0", "refund empties the record");
    assert.strictEqual(record.claimed, true, "the claimed flag outlives the refund");

    // And the farming loop is dead for a second reason too: the window never
    // reopens, so a refunded wallet cannot re-contribute to this campaign at
    // all — there is no path back to a live, unclaimed-shaped record.
    try {
      await send([await contributeIx(c, CONTRIBUTION)]);
      assert.fail("a contribution after the deadline must be refused");
    } catch (err) {
      assertErrorIs(err, "FundraiserEnded", "the window stays shut after the refund");
    }
    assert.strictEqual(await tokenBalance(c.receiptAta), 1n, "still exactly one badge");
  });

  it("a contributor who refunds before claiming keeps nothing and cannot claim on an empty record", async () => {
    const c = await setupCampaign();

    await send([await contributeIx(c, CONTRIBUTION)]);

    // Refund BEFORE ever claiming: the record is emptied, so the claim must
    // find nothing to receipt even though the wallet genuinely contributed
    // once. (The badge is gone for good — the price of the anti-farm rule.)
    await advanceDays(8n);
    await send([await refundIx(c)]);

    try {
      await send([await claimIx(c)]);
      assert.fail("an emptied record must not mint a badge");
    } catch (err) {
      assertErrorIs(err, "NothingToReceipt", "amount == 0 → nothing to receipt");
    }
    assert.strictEqual(await tokenBalance(c.receiptAta), 0n, "no badge was minted");
  });

  it("a second refund on an emptied record fails with NothingToRefund", async () => {
    const c = await setupCampaign();

    await send([await contributeIx(c, CONTRIBUTION)]);
    await advanceDays(8n);
    await send([await refundIx(c)]);

    // One slot forward so the second refund does not reuse the first one's
    // blockhash — in bankrun, two transactions in the same slot are the same
    // transaction as far as the bank is concerned.
    await nextSlot();

    try {
      await send([await refundIx(c)]);
      assert.fail("a second refund must be rejected");
    } catch (err) {
      assertErrorIs(err, "NothingToRefund", "the record was emptied by the first refund");
    }
    // The contributor is still made whole either way.
    assert.strictEqual(await tokenBalance(c.contributorAta), BigInt(10 * CONTRIBUTION));
  });
});
