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
  getAccount,
  createBurnInstruction,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { assert, AssertionError } from "chai";

/**
 * The other half of the contribution window — the half you cannot reach from
 * `anchor test`, because it runs against a real validator whose clock is the real
 * clock.
 *
 * `solana-bankrun` runs the program against an in-process bank and lets the test
 * set the clock sysvar directly, so a fourteen day campaign can be fast-forwarded
 * past its deadline in a millisecond. That is what makes "contributions stop" and
 * "refunds start" testable at all.
 */
describe("fundraiser — the window closes (bankrun)", () => {
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

    // Built from the IDL rather than `anchor.workspace`, so this file does not
    // depend on the workspace being resolvable at import time.
    const idl = require("../target/idl/fundraiser.json");
    program = new anchor.Program<Fundraiser>(idl, provider);
    payer = context.payer;
  });

  /** Signs with the payer plus any extras and runs the transaction. */
  const send = async (
    ixs: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Keypair[] = []
  ) => {
    const tx = new anchor.web3.Transaction();
    // Fetch it each time: two identical transactions on the same blockhash are
    // the same transaction, and the bank rejects the second as already processed.
    const [blockhash] = await context.banksClient.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(...ixs);
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
  };

  /**
   * Moves the bank forward by `days`.
   *
   * Warping the slot first is what gives us a new blockhash; setting the clock is
   * what the program actually reads. Both are needed — `warpToSlot` on its own
   * leaves `unix_timestamp` exactly where it was.
   */
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

  const tokenBalance = async (address: anchor.web3.PublicKey, programId = TOKEN_PROGRAM_ID): Promise<bigint> => {
    const account = await context.banksClient.getAccount(address);
    assert.isNotNull(account, "token account should exist");
    return unpackAccount(address, {
      ...account!,
      data: Buffer.from(account!.data),
      owner: new anchor.web3.PublicKey(account!.owner),
    } as any, programId).amount;
  };

  /**
   * The Anchor error name for a rejected transaction.
   *
   * `banksClient.processTransaction` throws a plain string rather than an
   * AnchorError, so a raw `custom program error: 0x1776` has to be looked up in
   * the IDL by number. That is the one real ergonomic cost of bankrun.
   */
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

  /** Case-insensitive because Anchor's IDL camelCases error names while the
   *  runtime's parsed AnchorError reports them in PascalCase. */
  const assertErrorIs = (err: any, expected: string, why: string) => {
    const actual = errorCodeOf(err);
    assert.strictEqual(
      actual.toLowerCase(),
      expected.toLowerCase(),
      `${why} (expected ${expected}, got ${actual})`
    );
  };

  it("stops contributions and opens refunds once the deadline passes", async () => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;

    // --- a mint, and a contributor holding some of it -------------------
    const rent = await context.banksClient.getRent();
    const mintRent = Number(rent.minimumBalance(BigInt(MINT_SIZE)));

    const contributorAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

    await send(
      [
        // The maker pays rent for the fundraiser account and the vault, and in
        // bankrun there is no airdrop — fund them from the payer.
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
      ],
      [mintKeypair]
    );

    // --- open a seven day campaign --------------------------------------
    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await send([
      await program.methods.initialize(new anchor.BN(TARGET), DURATION_DAYS).accountsPartial({
        maker: maker.publicKey, mintToRaise: mint, fundraiser, vault
      }).instruction(),
    ], [maker]);
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), payer.publicKey.toBuffer()],
      program.programId
    );
    
    const [receiptMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), fundraiser.toBuffer(), payer.publicKey.toBuffer()],
      program.programId
    );
    const contributorReceiptAta = getAssociatedTokenAddressSync(
      receiptMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID
    );

    // --- day 0: the window is open --------------------------------------
    try {
      await send([
        await program.methods.contribute(new anchor.BN(CONTRIBUTION)).accountsPartial({
          contributor: payer.publicKey, mintToRaise: mint, fundraiser, contributorAccount, contributorAta, vault, receiptMint, contributorReceiptAta
        }).instruction()
      ]);
    } catch (err: any) {
      console.log("Contribute failed with error:", err.message, err.logs);
      assert.fail(
        `a contribution on day 0 of a ${DURATION_DAYS} day fundraiser must be ` +
          `accepted, but it was rejected with ${errorCodeOf(err)}`
      );
    }
    assert.strictEqual(
      await tokenBalance(vault),
      BigInt(CONTRIBUTION),
      "the contribution should be in the vault"
    );

    // --- day 8: past the deadline, and short of the target ---------------
    await advanceDays(8n);

    try {
      await send([
        await program.methods.contribute(new anchor.BN(CONTRIBUTION)).accountsPartial({
          contributor: payer.publicKey, mintToRaise: mint, fundraiser, contributorAccount, contributorAta, vault, receiptMint, contributorReceiptAta
        }).instruction()
      ]);
      assert.fail("a contribution after the deadline must be refused");
    } catch (err) {
      assertErrorIs(err, "FundraiserEnded",
        "the contribution should be refused because the window has closed");
    }

    // The campaign failed, so the money has to be reachable again.
    await send([
      await program.methods
        .refund()
        .accountsPartial({
          contributor: payer.publicKey,
          maker: maker.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount,
          contributorAta,
          vault,
          receiptMint,
          contributorReceiptAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction(),
    ]);

    assert.strictEqual(await tokenBalance(vault), 0n, "the vault should be empty");
    assert.strictEqual(
      await tokenBalance(contributorAta),
      BigInt(10 * CONTRIBUTION),
      "the contributor should have every token back"
    );
    
    // 4. Abuse case, refund: receipt ATA balance is 0
    assert.strictEqual(await tokenBalance(contributorReceiptAta, TOKEN_2022_PROGRAM_ID), 0n, "the receipt ATA should be empty (receipt burned)");
  });

  it("Abuse case, refund: cannot refund without burning receipt", async () => {
    // Setup campaign
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;
    const rent = await context.banksClient.getRent();
    const mintRent = Number(rent.minimumBalance(BigInt(MINT_SIZE)));
    const contributorAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

    await send(
      [
        anchor.web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: maker.publicKey, lamports: anchor.web3.LAMPORTS_PER_SOL }),
        anchor.web3.SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: MINT_SIZE, lamports: mintRent, programId: TOKEN_PROGRAM_ID }),
        createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
        createAssociatedTokenAccountInstruction(payer.publicKey, contributorAta, payer.publicKey, mint),
        createMintToInstruction(mint, contributorAta, payer.publicKey, 10 * CONTRIBUTION),
      ],
      [mintKeypair]
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("fundraiser"), maker.publicKey.toBuffer()], program.programId);
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("contributor"), fundraiser.toBuffer(), payer.publicKey.toBuffer()], program.programId);
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    
    const [receiptMint] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("receipt"), fundraiser.toBuffer(), payer.publicKey.toBuffer()], program.programId);
    const contributorReceiptAta = getAssociatedTokenAddressSync(receiptMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);

    await send([
      await program.methods.initialize(new anchor.BN(TARGET), DURATION_DAYS).accountsPartial({
        maker: maker.publicKey, mintToRaise: mint, fundraiser, vault, systemProgram: anchor.web3.SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      }).instruction(),
    ], [maker]);

    // Contribute
    await send([
      await program.methods.contribute(new anchor.BN(CONTRIBUTION)).accountsPartial({
        contributor: payer.publicKey, mintToRaise: mint, fundraiser, contributorAccount, contributorAta, vault, receiptMint, contributorReceiptAta
      }).instruction()
    ]);

    // Advance time
    await advanceDays(8n);

    // Sanity check: bypass refund's internal burn CPI by burning manually, leaving balance 0.
    await send([
      createBurnInstruction(contributorReceiptAta, receiptMint, payer.publicKey, 1, [], TOKEN_2022_PROGRAM_ID)
    ]);

    try {
      await send([
        await program.methods.refund().accountsPartial({
          contributor: payer.publicKey, maker: maker.publicKey, mintToRaise: mint, fundraiser, contributorAccount, contributorAta, vault, receiptMint, contributorReceiptAta, token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId,
        }).instruction(),
      ]);
      assert.fail("Refund should have failed because the receipt token was already burned (balance 0)");
    } catch (err: any) {
      const errStr = errorCodeOf(err);
      // Custom error 1 in SPL token is InsufficientFunds
      assert.isTrue(
        errStr.includes("custom error 1") || errStr.toLowerCase().includes("insufficientfunds"),
        `Expected InsufficientFunds error, got ${errStr}`
      );
    }
  });
});
