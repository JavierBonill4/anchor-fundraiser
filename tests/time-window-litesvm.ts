import * as path from "path";

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import NodeWallet from "@anchor-lang/core/dist/cjs/nodewallet";
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
import {
  address as kitAddress,
  getTransactionDecoder,
  lamports,
} from "@solana/kit";
import { assert, AssertionError } from "chai";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";

import { Fundraiser } from "../target/types/fundraiser";

/**
 * The other half of the contribution window — the half a real validator cannot
 * reach during a test because its clock follows real time.
 *
 * LiteSVM runs the compiled program in-process and lets this test move the Clock
 * sysvar forward, so a seven-day campaign can be tested in milliseconds.
 */
describe("fundraiser — the window closes (LiteSVM)", () => {
  const TARGET = 30_000_000;
  const CONTRIBUTION = 1_000_000;
  const DURATION_DAYS = 7;
  const DAY = 86_400n;
  const SLOTS_PER_DAY = 216_000n; // 400ms slots

  let svm: LiteSVM;
  let program: Program<Fundraiser>;
  let payer: anchor.web3.Keypair;

  before(() => {
    payer = anchor.web3.Keypair.generate();
    svm = new LiteSVM().withSysvars();
    svm.addProgramFromFile(
      kitAddress(require("../target/idl/fundraiser.json").address),
      path.resolve("target/deploy/fundraiser.so"),
    );

    const airdrop = svm.airdrop(
      kitAddress(payer.publicKey.toBase58()),
      lamports(BigInt(10 * anchor.web3.LAMPORTS_PER_SOL)),
    );
    if (airdrop instanceof FailedTransactionMetadata) {
      throw new Error(`LiteSVM airdrop failed: ${airdrop.err().toString()}`);
    }

    // Building fully-specified instructions does not use this RPC connection;
    // transactions are executed directly by LiteSVM in `send` below.
    const provider = new anchor.AnchorProvider(
      new anchor.web3.Connection("http://127.0.0.1:8899"),
      new NodeWallet(payer),
      anchor.AnchorProvider.defaultOptions(),
    );
    program = new anchor.Program<Fundraiser>(
      require("../target/idl/fundraiser.json"),
      provider,
    );
  });

  /** Signs with the payer plus any extras and executes inside LiteSVM. */
  const send = async (
    instructions: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Keypair[] = [],
  ) => {
    // Every transaction needs a distinct blockhash, including expected failures.
    svm.expireBlockhash();

    const transaction = new anchor.web3.Transaction();
    transaction.recentBlockhash = svm.latestBlockhash();
    transaction.feePayer = payer.publicKey;
    transaction.add(...instructions);
    transaction.sign(payer, ...signers);

    const result = svm.sendTransaction(
      getTransactionDecoder().decode(transaction.serialize()),
    );
    if (result instanceof FailedTransactionMetadata) {
      const logs = result.meta().logs();
      const error = new Error(
        `${result.err().toString()}\n${logs.join("\n")}`,
      ) as Error & { logs?: string[] };
      error.logs = logs;
      throw error;
    }

    return result;
  };

  const advanceDays = (days: bigint) => {
    const before = svm.getClock();
    svm.warpToSlot(before.slot + days * SLOTS_PER_DAY);

    const clock = svm.getClock();
    clock.unixTimestamp = before.unixTimestamp + days * DAY;
    svm.setClock(clock);
  };

  const tokenBalance = (address: anchor.web3.PublicKey): bigint => {
    const account = svm.getAccount(kitAddress(address.toBase58()));
    assert.isTrue(account.exists, "token account should exist");
    if (!account.exists) throw new Error("token account should exist");

    return unpackAccount(address, {
      data: Buffer.from(account.data),
      executable: account.executable,
      lamports: Number(account.lamports),
      owner: new anchor.web3.PublicKey(account.programAddress),
      rentEpoch: 0,
    }).amount;
  };

  const errorCodeOf = (error: any): string => {
    if (error instanceof AssertionError) throw error;
    if (error?.error?.errorCode?.code) return error.error.errorCode.code;

    const text = `${error?.message ?? ""} ${JSON.stringify(error?.logs ?? [])}`;
    const byName = text.match(/Error Code: (\w+)/);
    if (byName) return byName[1];

    const byNumber = text.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (byNumber) {
      const code = parseInt(byNumber[1], 16);
      const known = (program.idl.errors ?? []).find(
        (entry: any) => entry.code === code,
      );
      return known?.name ?? `custom error ${code}`;
    }

    return text.slice(0, 300);
  };

  const assertErrorIs = (error: any, expected: string, reason: string) => {
    const actual = errorCodeOf(error);
    assert.strictEqual(
      actual.toLowerCase(),
      expected.toLowerCase(),
      `${reason} (expected ${expected}, got ${actual})`,
    );
  };

  it("stops contributions and opens refunds once the deadline passes", async () => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;
    const contributorAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

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
          lamports: Number(
            svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)),
          ),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          contributorAta,
          payer.publicKey,
          mint,
        ),
        createMintToInstruction(
          mint,
          contributorAta,
          payer.publicKey,
          10 * CONTRIBUTION,
        ),
      ],
      [mintKeypair],
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId,
    );
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        fundraiser.toBuffer(),
        payer.publicKey.toBuffer(),
      ],
      program.programId,
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await send(
      [
        await program.methods
          .initialize(new anchor.BN(TARGET), DURATION_DAYS, 300)
          .accountsPartial({
            maker: maker.publicKey,
            beneficiary: payer.publicKey,
            mintToRaise: mint,
            fundraiser,
            vault,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [maker],
    );

    const contributeInstruction = () =>
      program.methods
        .contribute(new anchor.BN(CONTRIBUTION))
        .accountsPartial({
          contributor: payer.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount,
          contributorAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction();

    try {
      await send([await contributeInstruction()]);
    } catch (error) {
      assert.fail(
        `a contribution on day 0 of a ${DURATION_DAYS} day fundraiser must be ` +
          `accepted, but it was rejected with ${errorCodeOf(error)}`,
      );
    }
    assert.strictEqual(tokenBalance(vault), BigInt(CONTRIBUTION));

    advanceDays(8n);

    try {
      await send([await contributeInstruction()]);
      assert.fail("a contribution after the deadline must be refused");
    } catch (error) {
      assertErrorIs(
        error,
        "FundraiserEnded",
        "the contribution should be refused because the window has closed",
      );
    }

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
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction(),
    ]);

    assert.strictEqual(tokenBalance(vault), 0n, "the vault should be empty");
    assert.strictEqual(
      tokenBalance(contributorAta),
      BigInt(10 * CONTRIBUTION),
      "the contributor should have every token back",
    );

    const makerAta = getAssociatedTokenAddressSync(mint, maker.publicKey);
    assert.isFalse(
      svm.getAccount(kitAddress(makerAta.toBase58())).exists,
      "a failed campaign must not create a maker payout account or charge a fee",
    );
  });
});
