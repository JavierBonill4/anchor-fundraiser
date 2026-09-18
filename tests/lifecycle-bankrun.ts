import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { ProgramTestContext } from "solana-bankrun";
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
 * What happens to a campaign AFTER it settles.
 *
 * The guide describes the fundraiser seeds as "one per maker — a maker runs one
 * campaign at a time". These tests ask whether "at a time" is true:
 *
 *   - success: `check_contributions` closes the Fundraiser (`close = maker`) but
 *     nothing closes the vault ATA, and `initialize` creates the vault with
 *     `init`, not `init_if_needed`.
 *   - failure: `refund` closes the Contributor and nothing else, so the
 *     Fundraiser itself survives.
 *
 * Neither is covered by the shipped suite, which never opens a second campaign
 * for the same maker.
 *
 * The first test is a different claim: both terminal guards read `vault.amount`
 * and never `current_amount`, so a vault funded without going through
 * `contribute` still pays out.
 *
 * Bankrun rather than a validator, so this needs no wallet and no airdrop.
 */
describe("fundraiser — lifecycle after settlement (bankrun)", () => {
  const TARGET = 30_000_000; // 30 tokens at 6 decimals, over MIN_AMOUNT_TO_RAISE

  let context: ProgramTestContext;
  let program: Program<Fundraiser>;
  let payer: anchor.web3.Keypair;

  before(async () => {
    context = await startAnchor("", [], []);
    const provider = new BankrunProvider(context);
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

  const textOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    return `${err?.message ?? err} ${JSON.stringify(err?.logs ?? [])}`;
  };

  /**
   * A rejection has to be the rejection we are testing for.
   *
   * The dangerous false positive here is transaction dedup: the second
   * `initialize` is byte-identical to the first, so on an unchanged blockhash the
   * bank would refuse it as already-processed and the assertion would pass for
   * entirely the wrong reason.
   */
  const assertRefusedWith = (err: any, expected: RegExp, why: string) => {
    const text = textOf(err);
    assert.notMatch(
      text,
      /already processed|AlreadyProcessed|blockhash not found/i,
      `${why} — but the bank refused it as a duplicate transaction, not on its merits: ${text.slice(0, 300)}`
    );
    assert.match(text, expected, `${why} (got: ${text.slice(0, 300)})`);
  };

  const tokenBalance = async (address: anchor.web3.PublicKey): Promise<bigint> => {
    const account = await context.banksClient.getAccount(address);
    assert.isNotNull(account, `token account ${address.toBase58()} should exist`);
    return unpackAccount(address, {
      ...account!,
      data: Buffer.from(account!.data),
      owner: new anchor.web3.PublicKey(account!.owner),
    } as any).amount;
  };

  const addresses = (maker: anchor.web3.PublicKey, mint: anchor.web3.PublicKey) => {
    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.toBuffer()],
      program.programId
    );
    return {
      fundraiser,
      vault: getAssociatedTokenAddressSync(mint, fundraiser, true),
      makerAta: getAssociatedTokenAddressSync(mint, maker),
    };
  };

  /** A funded maker and a fresh 6-decimal mint the bankrun payer controls. */
  const freshMakerAndMint = async () => {
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
          lamports: 2 * anchor.web3.LAMPORTS_PER_SOL,
        }),
        anchor.web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports: mintRent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
      ],
      [mintKeypair]
    );

    return { maker, mint };
  };

  const initializeIx = (
    maker: anchor.web3.Keypair,
    mint: anchor.web3.PublicKey,
    durationDays: number
  ) => {
    const { fundraiser, vault } = addresses(maker.publicKey, mint);
    return program.methods
      .initialize(new anchor.BN(TARGET), durationDays)
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .instruction();
  };

  const checkContributionsIx = (
    maker: anchor.web3.Keypair,
    mint: anchor.web3.PublicKey
  ) => {
    const { fundraiser, vault, makerAta } = addresses(maker.publicKey, mint);
    return program.methods
      .checkContributions()
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        vault,
        makerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .instruction();
  };

  /** Fund the vault to the target without going through `contribute`. */
  const fundVaultDirectly = async (vault: anchor.web3.PublicKey, mint: anchor.web3.PublicKey) =>
    send([createMintToInstruction(mint, vault, payer.publicKey, TARGET)]);

  /** New slot, so a resend is a genuinely new transaction rather than a duplicate. */
  const nextSlot = async () => {
    const clock = await context.banksClient.getClock();
    context.warpToSlot(clock.slot + 10n);
  };

  it("pays out a vault that never saw a contribution, with current_amount at 0", async () => {
    const { maker, mint } = await freshMakerAndMint();
    const { fundraiser, vault, makerAta } = addresses(maker.publicKey, mint);

    await send([await initializeIx(maker, mint, 7)], [maker]);
    await fundVaultDirectly(vault, mint);

    const state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(
      state.currentAmount.toString(),
      "0",
      "nothing went through contribute, so the program's own counter must read 0"
    );
    assert.strictEqual(
      await tokenBalance(vault),
      BigInt(TARGET),
      "the vault is nonetheless at target"
    );

    // check_contributions guards on vault.amount, not on current_amount.
    await send([await checkContributionsIx(maker, mint)], [maker]);

    assert.strictEqual(
      await tokenBalance(makerAta),
      BigInt(TARGET),
      "the maker was paid the full target on a campaign with zero recorded contributions"
    );
  });

  it("refuses a second campaign for the same maker and mint after SUCCESS", async () => {
    const { maker, mint } = await freshMakerAndMint();
    const { fundraiser, vault } = addresses(maker.publicKey, mint);

    await send([await initializeIx(maker, mint, 7)], [maker]);
    await fundVaultDirectly(vault, mint);
    await send([await checkContributionsIx(maker, mint)], [maker]);

    assert.isNull(
      await context.banksClient.getAccount(fundraiser),
      "check_contributions should have closed the fundraiser account"
    );
    assert.isNotNull(
      await context.banksClient.getAccount(vault),
      "the vault ATA survives settlement — nothing closes it"
    );

    await nextSlot();
    try {
      await send([await initializeIx(maker, mint, 7)], [maker]);
      assert.fail(
        "a second campaign for the same maker and mint was accepted — the vault ATA must have been closed after all"
      );
    } catch (err) {
      // The fundraiser PDA was freed by `close = maker`, so Anchor re-creates it
      // without complaint; the refusal comes one account later, from the
      // Associated Token Account program, because the vault is still there.
      assertRefusedWith(
        err,
        /Provided owner is not allowed/i,
        "expected the second initialize to be refused by the ATA program because the vault survived settlement"
      );
    }
  });

  it("refuses a second campaign for the same maker and mint after FAILURE", async () => {
    const { maker, mint } = await freshMakerAndMint();
    const { fundraiser } = addresses(maker.publicKey, mint);

    // duration 0 closes the window the moment it opens: no contribution is
    // possible, and no instruction exists that closes the Fundraiser.
    await send([await initializeIx(maker, mint, 0)], [maker]);

    assert.isNotNull(
      await context.banksClient.getAccount(fundraiser),
      "nothing on the failure path closes the fundraiser account"
    );

    await nextSlot();
    try {
      await send([await initializeIx(maker, mint, 7)], [maker]);
      assert.fail("a second campaign was accepted after a dead one — the fundraiser must persist");
    } catch (err) {
      // Nothing closed the fundraiser, so the refusal comes from the System
      // program at the very first account Anchor tries to allocate.
      assertRefusedWith(
        err,
        /custom program error: 0x0/i,
        "expected the second initialize to be refused by the System program because the fundraiser PDA already exists"
      );
    }
  });
});
