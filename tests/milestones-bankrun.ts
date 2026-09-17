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
import { assert } from "chai";

/**
 * Milestones: 25 / 50 / 75.
 *
 * Bit 0 = 25%, bit 1 = 50%, bit 2 = 75%.
 * The program caps one contributor at 10% of the target, so a single wallet
 * cannot leap over a mark. These tests use several contributors instead.
 */
describe("fundraiser — milestones (bankrun)", () => {
  const TARGET = 40_000_000; // 40 tokens at 6 decimals
  const TEN_PERCENT = 4_000_000; // max allowed per contributor
  const FIVE_PERCENT = 2_000_000;
  const DURATION_DAYS = 7;
  const DAY = 86_400n;
  const SLOTS_PER_DAY = 216_000n;

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

  const tokenBalance = async (address: anchor.web3.PublicKey): Promise<bigint> => {
    const account = await context.banksClient.getAccount(address);
    assert.isNotNull(account, "token account should exist");
    return unpackAccount(address, {
      ...account!,
      data: Buffer.from(account!.data),
      owner: new anchor.web3.PublicKey(account!.owner),
    } as any).amount;
  };

  const bitsOf = async (fundraiser: anchor.web3.PublicKey): Promise<number> => {
    const account = await program.account.fundraiser.fetch(fundraiser);
    return Number(account.milestonesFired);
  };

  const openCampaign = async () => {
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
          .initialize(new anchor.BN(TARGET), DURATION_DAYS)
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

  const fundWallet = async (mint: anchor.web3.PublicKey, owner: anchor.web3.Keypair) => {
    if (!owner.publicKey.equals(payer.publicKey)) {
      await send([
        anchor.web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: owner.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        }),
      ]);
    }
    const ata = getAssociatedTokenAddressSync(mint, owner.publicKey);
    await send(
      [
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ata,
          owner.publicKey,
          mint
        ),
        createMintToInstruction(mint, ata, payer.publicKey, 20 * TEN_PERCENT),
      ]
    );
    return ata;
  };

  const contributeFrom = async (
    owner: anchor.web3.Keypair,
    amount: number,
    mint: anchor.web3.PublicKey,
    fundraiser: anchor.web3.PublicKey,
    vault: anchor.web3.PublicKey,
    ata: anchor.web3.PublicKey
  ) => {
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), owner.publicKey.toBuffer()],
      program.programId
    );
    await send(
      [
        await program.methods
          .contribute(new anchor.BN(amount))
          .accountsPartial({
            contributor: owner.publicKey,
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
      owner.publicKey.equals(payer.publicKey) ? [] : [owner]
    );
    return contributorAccount;
  };

  it("happy path: landing exactly on 25% sets only bit 0", async () => {
    const { maker, mint, fundraiser, vault } = await openCampaign();
    const a = anchor.web3.Keypair.generate();
    const b = anchor.web3.Keypair.generate();
    const c = anchor.web3.Keypair.generate();
    const ataA = await fundWallet(mint, a);
    const ataB = await fundWallet(mint, b);
    const ataC = await fundWallet(mint, c);

    await contributeFrom(a, TEN_PERCENT, mint, fundraiser, vault, ataA);
    await contributeFrom(b, TEN_PERCENT, mint, fundraiser, vault, ataB);
    assert.strictEqual(await bitsOf(fundraiser), 0, "20% must not fire 25%");

    await contributeFrom(c, FIVE_PERCENT, mint, fundraiser, vault, ataC);
    assert.strictEqual(await bitsOf(fundraiser), 0b001, "exactly 25% sets only bit 0");
    assert.strictEqual(await tokenBalance(vault), BigInt(TEN_PERCENT + TEN_PERCENT + FIVE_PERCENT));
  });

  it("boundary: crossing 25/50/75 with separate 10% gifts sets bits in order and does not skip", async () => {
    const { mint, fundraiser, vault } = await openCampaign();
    const bits: number[] = [];
    for (let i = 0; i < 8; i++) {
      const donor = anchor.web3.Keypair.generate();
      const ata = await fundWallet(mint, donor);
      await contributeFrom(donor, TEN_PERCENT, mint, fundraiser, vault, ata);
      bits.push(await bitsOf(fundraiser));
    }
    // 10,20,30,40,50,60,70,80 percent
    assert.deepEqual(bits, [0, 0, 0b001, 0b001, 0b011, 0b011, 0b011, 0b111]);
  });

  it("abuse: refunds drop the total but do not clear milestone bits", async () => {
    const { maker, mint, fundraiser, vault } = await openCampaign();
    const a = anchor.web3.Keypair.generate();
    const b = anchor.web3.Keypair.generate();
    const c = anchor.web3.Keypair.generate();
    const ataA = await fundWallet(mint, a);
    const ataB = await fundWallet(mint, b);
    const ataC = await fundWallet(mint, c);

    await contributeFrom(a, TEN_PERCENT, mint, fundraiser, vault, ataA);
    await contributeFrom(b, TEN_PERCENT, mint, fundraiser, vault, ataB);
    const contributorC = await contributeFrom(c, FIVE_PERCENT, mint, fundraiser, vault, ataC);
    assert.strictEqual(await bitsOf(fundraiser), 0b001);

    await advanceDays(8n);

    await send(
      [
        await program.methods
          .refund()
          .accountsPartial({
            contributor: c.publicKey,
            maker: maker.publicKey,
            mintToRaise: mint,
            fundraiser,
            contributorAccount: contributorC,
            contributorAta: ataC,
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
      ],
      [c]
    );

    assert.strictEqual(await bitsOf(fundraiser), 0b001, "refund must not turn bit 0 off");
    const account = await program.account.fundraiser.fetch(fundraiser);
    assert.ok(account.currentAmount.lt(new anchor.BN(TARGET / 4)));
  });
});
