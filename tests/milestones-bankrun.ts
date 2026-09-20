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
import { assert } from "chai";

/**
 * The abuse test for milestones, and the reason it needs bankrun.
 *
 * A milestone must fire once and stay fired. The way to break that is a
 * contribute/refund cycle: reach 25%, take the money back, and if the bitmask
 * were cleared the same mark could be announced again on the next
 * contribution — as many times as someone cares to repeat it.
 *
 * Proving the flag survives needs a contribution (window open) and then a
 * refund (window closed) against the same campaign, which is impossible
 * against a real validator whose clock is the real clock. Bankrun can set the
 * clock, so the whole cycle fits in one test.
 */
describe("fundraiser — milestones survive a refund (bankrun)", () => {
  const TARGET = 30_000_000;
  const MAX_PER_WALLET = TARGET / 10;
  const DURATION_DAYS = 7;
  const DAY = 86_400n;
  const SLOTS_PER_DAY = 216_000n;
  const MILESTONE_25 = 0b001;

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

  it("keeps the 25% milestone after a refund drops the total below it", async () => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;

    const rent = await context.banksClient.getRent();
    const mintRent = Number(rent.minimumBalance(BigInt(MINT_SIZE)));

    // Three contributors: the 10% per-wallet cap makes 25% unreachable from
    // fewer than three.
    const contributors = [
      anchor.web3.Keypair.generate(),
      anchor.web3.Keypair.generate(),
      anchor.web3.Keypair.generate(),
    ];
    const atas = contributors.map((c) => getAssociatedTokenAddressSync(mint, c.publicKey));

    await send(
      [
        anchor.web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: maker.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        }),
        ...contributors.map((c) =>
          anchor.web3.SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: c.publicKey,
            lamports: anchor.web3.LAMPORTS_PER_SOL,
          })
        ),
        anchor.web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports: mintRent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
        ...contributors.flatMap((c, i) => [
          createAssociatedTokenAccountInstruction(payer.publicKey, atas[i], c.publicKey, mint),
          createMintToInstruction(mint, atas[i], payer.publicKey, MAX_PER_WALLET),
        ]),
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

    const accountFor = (c: anchor.web3.Keypair) =>
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("contributor"), fundraiser.toBuffer(), c.publicKey.toBuffer()],
        program.programId
      )[0];

    // --- window open: three contributions, 30% of the target ------------
    for (let i = 0; i < contributors.length; i++) {
      await send(
        [
          await program.methods
            .contribute(new anchor.BN(MAX_PER_WALLET))
            .accountsPartial({
              contributor: contributors[i].publicKey,
              mintToRaise: mint,
              fundraiser,
              contributorAccount: accountFor(contributors[i]),
              contributorAta: atas[i],
              vault,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .instruction(),
        ],
        [contributors[i]]
      );
    }

    let state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(
      state.milestonesReached & MILESTONE_25,
      MILESTONE_25,
      "precondition: 30% of the target passes the 25% mark"
    );

    // --- the window closes, and one contributor pulls out ---------------
    await advanceDays(BigInt(DURATION_DAYS + 1));

    await send(
      [
        await program.methods
          .refund()
          .accountsPartial({
            contributor: contributors[2].publicKey,
            maker: maker.publicKey,
            mintToRaise: mint,
            fundraiser,
            contributorAccount: accountFor(contributors[2]),
            contributorAta: atas[2],
            vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
      ],
      [contributors[2]]
    );

    state = await program.account.fundraiser.fetch(fundraiser);

    // The refund really happened: the total is back under the threshold.
    assert.isBelow(
      state.currentAmount.toNumber(),
      TARGET / 4,
      "the refund should have dropped the total below 25%"
    );

    // And the flag did not follow it down.
    assert.strictEqual(
      state.milestonesReached & MILESTONE_25,
      MILESTONE_25,
      "a milestone, once passed, stays passed — clearing it would let the same " +
        "mark be announced again on the next contribution"
    );
  });
});
