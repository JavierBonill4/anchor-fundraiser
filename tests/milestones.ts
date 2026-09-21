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
 * Milestones: a u8 bitmask on Fundraiser (bit0=25%, bit1=50%, bit2=75%),
 * recomputed from scratch on every contribute and refund by the same pure
 * function (Fundraiser::milestones_for). That symmetry is the whole point:
 * contribute can only add bits, refund can only remove them, and neither
 * path can disagree with the other about which milestones are still earned.
 *
 * Bankrun is required here, not just convenient: refund only runs once the
 * window has closed, and the bit-clearing behavior can only be exercised
 * past that deadline.
 */
describe("fundraiser — milestones", () => {
  const DAY = 86_400n;
  const SLOTS_PER_DAY = 216_000n;
  const ONE_TOKEN = 1_000_000; // 6 decimals

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

  /** A funded, ready-to-contribute wallet with its own ATA for `mint`. */
  const newFundedContributor = async (
    mint: anchor.web3.PublicKey,
    amount: number
  ) => {
    const wallet = anchor.web3.Keypair.generate();
    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
    await send([
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: wallet.publicKey,
        lamports: anchor.web3.LAMPORTS_PER_SOL,
      }),
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, wallet.publicKey, mint),
      createMintToInstruction(mint, ata, payer.publicKey, amount),
    ]);
    return { wallet, ata };
  };

  /** Opens a `target`-token, 7 day campaign with a fresh mint and maker. */
  const openCampaign = async (target: number) => {
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
          .initialize(new anchor.BN(target), 7)
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

    return { maker, mint, fundraiser, vault };
  };

  const contributorAccountOf = (fundraiser: anchor.web3.PublicKey, contributor: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), contributor.toBuffer()],
      program.programId
    )[0];

  const contribute = async (
    mint: anchor.web3.PublicKey,
    fundraiser: anchor.web3.PublicKey,
    vault: anchor.web3.PublicKey,
    contributorWallet: anchor.web3.Keypair,
    contributorAta: anchor.web3.PublicKey,
    amount: number
  ) => {
    const contributorAccount = contributorAccountOf(fundraiser, contributorWallet.publicKey);
    return send(
      [
        await program.methods
          .contribute(new anchor.BN(amount))
          .accountsPartial({
            contributor: contributorWallet.publicKey,
            mintToRaise: mint,
            fundraiser,
            contributorAccount,
            contributorAta,
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
      ],
      [contributorWallet]
    );
  };

  it("sets both the 25% and 50% bits once total contributions cross 50%, but not 75%", async () => {
    const TARGET = 100 * ONE_TOKEN;
    const { mint, fundraiser, vault } = await openCampaign(TARGET);

    // Three wallets, each under their own 10% cap, adding to 60% total.
    for (const pct of [10, 10, 10, 10, 10, 10]) {
      const amount = pct * ONE_TOKEN;
      const { wallet, ata } = await newFundedContributor(mint, amount);
      await contribute(mint, fundraiser, vault, wallet, ata, amount);
    }

    const state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.milestones, 0b011, "25% and 50% should be set, 75% should not be");
  });

  it("sets the 25% bit only once the total reaches exactly the threshold, not one token before", async () => {
    const TARGET = 100 * ONE_TOKEN;
    const { mint, fundraiser, vault } = await openCampaign(TARGET);

    // 10 + 10 + 4 = 24 tokens: one token short of the 25-token threshold.
    for (const pct of [10, 10, 4]) {
      const amount = pct * ONE_TOKEN;
      const { wallet, ata } = await newFundedContributor(mint, amount);
      await contribute(mint, fundraiser, vault, wallet, ata, amount);
    }
    let state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.milestones, 0, "24% must not trip the 25% milestone");

    // One more token lands exactly on the threshold.
    const { wallet, ata } = await newFundedContributor(mint, ONE_TOKEN);
    await contribute(mint, fundraiser, vault, wallet, ata, ONE_TOKEN);

    state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.milestones, 0b001, "exactly 25% must trip the milestone (>=, not >)");
  });

  it("rejects a contribution to a fundraiser whose target would overflow the milestone math", async () => {
    // amount_to_raise * 75 must exceed u64::MAX for the checked_mul to fail.
    const HUGE_TARGET = new anchor.BN("300000000000000000"); // 3e17: overflows the 75% milestone check (x75 > u64::MAX) but not the existing 10% cap check (x10 well under u64::MAX)
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
          .initialize(HUGE_TARGET, 7)
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

    const { wallet, ata } = await newFundedContributor(mint, ONE_TOKEN);

    try {
      await contribute(mint, fundraiser, vault, wallet, ata, ONE_TOKEN);
      assert.fail("a fundraiser target this large should overflow the milestone math");
    } catch (err) {
      assertErrorIs(err, "MilestoneOverflow",
        "amount_to_raise * 75 overflows u64, and checked_mul must catch it");
    }
  });

  it("clears milestone bits on refund, symmetric with how contribute sets them", async () => {
    const TARGET = 100 * ONE_TOKEN;
    const { maker, mint, fundraiser, vault } = await openCampaign(TARGET);

    // Two wallets to 60%: crosses 25% and 50%.
    const contributors: { wallet: anchor.web3.Keypair; ata: anchor.web3.PublicKey }[] = [];
    for (const pct of [10, 10, 10, 10, 10, 10]) {
      const amount = pct * ONE_TOKEN;
      const c = await newFundedContributor(mint, amount);
      await contribute(mint, fundraiser, vault, c.wallet, c.ata, amount);
      contributors.push(c);
    }

    let state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.milestones, 0b011, "sanity check: should be at 60% before refunds");

    // Window closes, target missed (60% < 100%) — refunds open.
    await advanceDays(8n);

    // Refund every contributor; each refund recomputes the bitmask from the
    // new, lower total. After all of them, nothing is left, so no bits.
    for (const c of contributors) {
      await send(
        [
          await program.methods
            .refund()
            .accountsPartial({
              contributor: c.wallet.publicKey,
              maker: maker.publicKey,
              mintToRaise: mint,
              fundraiser,
              contributorAccount: contributorAccountOf(fundraiser, c.wallet.publicKey),
              contributorAta: c.ata,
              vault,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .instruction(),
        ],
        [c.wallet]
      );
    }

    state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.milestones, 0, "every milestone should be cleared once every refund lands");
  });
});
