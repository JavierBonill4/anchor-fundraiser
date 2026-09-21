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
import { createHash } from "crypto";

describe("fundraiser — lottery (bankrun)", () => {
  const TARGET = 1_000_000_000; // 1000 tokens at 6 decimals
  const DURATION_DAYS = 1;
  const REWARD_BPS = 1_000; // winner takes 10% of the final pot

  const DAY = 86_400n;
  const REVEAL_WINDOW_SECS = 2n * 3600n;
  const PENALTY_DELAY_SECS = 24n * 3600n;
  const SLOTS_PER_SEC = 5n / 2n; // 400ms slots

  const SECRET = Buffer.alloc(32, 7);
  const WRONG_SECRET = Buffer.alloc(32, 9);
  const revealHash = createHash("sha256").update(SECRET).digest();

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

 const advanceSeconds = async (seconds: bigint) => {
    const before = await context.banksClient.getClock();
    context.warpToSlot(before.slot + (seconds * 5n) / 2n); // 400ms slots

    const clock = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        before.unixTimestamp + seconds
      )
    );
  };

  const SLOT_HASHES_ID = new anchor.web3.PublicKey(
  "SysvarS1otHashes111111111111111111111111111"
);
const SYSVAR_OWNER = new anchor.web3.PublicKey(
  "Sysvar1111111111111111111111111111111111111"
);

const seedSlotHashes = async (entryHash: Buffer) => {
const existing = await context.banksClient.getAccount(SLOT_HASHES_ID);
const lamports = existing ? Number(existing.lamports) : 143_487_360; // must not change

const data = Buffer.alloc(8 + 8 + 32);
    data.writeBigUInt64LE(1n, 0);   // entry count
    data.writeBigUInt64LE(0n, 8);   // slot
    entryHash.copy(data, 16);       // hash

    await context.setAccount(SLOT_HASHES_ID, {
        lamports,
        data,
        owner: SYSVAR_OWNER,
        executable: false,
        rentEpoch: 0n as any,
    });
};
  const expectedWinningTicket = (
    secret: Buffer,
    slotHashEntry: Buffer,
    totalTickets: bigint
  ): bigint => {
    const digest = createHash("sha256")
      .update(Buffer.concat([secret, slotHashEntry]))
      .digest();
    const randU64 = digest.readBigUInt64LE(0);
    return randU64 % totalTickets;
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

  const solBalance = async (address: anchor.web3.PublicKey): Promise<bigint> => {
    const account = await context.banksClient.getAccount(address);
    return account ? BigInt(account.lamports) : 0n;
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
      const FRAMEWORK_ERRORS: Record<number, string> = {
        3012: "AccountNotInitialized",
      };
      if (FRAMEWORK_ERRORS[code]) return FRAMEWORK_ERRORS[code];
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

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    bond: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  const openCampaign = async (): Promise<Campaign> => {
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
          lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
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
    const [bond] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bond"), fundraiser.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await send(
      [
        await program.methods
          .initialize(new anchor.BN(TARGET), DURATION_DAYS, Array.from(revealHash), REWARD_BPS)
          .accountsPartial({
            maker: maker.publicKey,
            mintToRaise: mint,
            fundraiser,
            vault,
            bond,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [maker]
    );

    return { maker, mint, fundraiser, bond, vault };
  };

  const newFundedContributor = async (
    c: Campaign,
    fundingTokens: number
    ): Promise<{ kp: anchor.web3.Keypair; ata: anchor.web3.PublicKey }> => {
    const kp = anchor.web3.Keypair.generate();
    const ata = getAssociatedTokenAddressSync(c.mint, kp.publicKey);
    await send([
        anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: kp.publicKey,
        lamports: Math.floor(0.05 * anchor.web3.LAMPORTS_PER_SOL), 
        }),
        createAssociatedTokenAccountInstruction(payer.publicKey, ata, kp.publicKey, c.mint),
        createMintToInstruction(c.mint, ata, payer.publicKey, fundingTokens),
    ]);
    return { kp, ata };
    };

  const contributorPda = (c: Campaign, wallet: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), c.fundraiser.toBuffer(), wallet.toBuffer()],
      program.programId
    )[0];

  const contribute = async (
    c: Campaign,
    contributor: anchor.web3.Keypair,
    contributorAta: anchor.web3.PublicKey,
    amount: number
  ) => {
    const contributorAccount = contributorPda(c, contributor.publicKey);
    await send(
      [
        await program.methods
          .contribute(new anchor.BN(amount))
          .accountsPartial({
            contributor: contributor.publicKey,
            mintToRaise: c.mint,
            fundraiser: c.fundraiser,
            contributorAccount,
            contributorAta,
            vault: c.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
      ],
      [contributor]
    );
    return contributorAccount;
  };

  
  const fundCampaignToTarget = async (c: Campaign, target: number) => {
    const perContributor = Math.floor(target * 0.05);
    const contributors: { kp: anchor.web3.Keypair; ata: anchor.web3.PublicKey; account: anchor.web3.PublicKey }[] = [];
    let funded = 0;
    while (funded < target) {
      const amount = Math.min(perContributor, target - funded);
      const { kp, ata } = await newFundedContributor(c, amount);
      const account = await contribute(c, kp, ata, amount);
      contributors.push({ kp, ata, account });
      funded += amount;
    }
    return contributors;
  };

 
  const findSlotHashForContributor = async (
    c: Campaign,
    target: { account: anchor.web3.PublicKey }
  ): Promise<Buffer> => {
    const fundraiserState = await program.account.fundraiser.fetch(c.fundraiser);
    const contributorState = await program.account.contributor.fetch(target.account);
    const totalTickets = BigInt(fundraiserState.totalTickets.toString());
    const start = BigInt(contributorState.ticketStart.toString());
    const end = BigInt(contributorState.ticketEnd.toString());

    for (let i = 0; i < 256; i++) {
      const entry = Buffer.alloc(32, i);
      const drawn = expectedWinningTicket(SECRET, entry, totalTickets);
      if (drawn >= start && drawn < end) {
        return entry;
      }
    }
    throw new Error("no slot hash entry lands in the target contributor's ticket range");
  };

  
  // Ticket issuance and its 5% cap
  

  it("issues 1 ticket per 0.25% of the pool, caps at 20 tickets, and refuses contributions past the 5% cap", async () => {
    const c = await openCampaign();
    const onePercent = TARGET / 100;
    const { kp, ata } = await newFundedContributor(c, onePercent * 20);

    const contributorAccount = await contribute(c, kp, ata, onePercent);
    let state = await program.account.contributor.fetch(contributorAccount);
    assert.strictEqual(
      state.ticketEnd.sub(state.ticketStart).toNumber(),
      4,
      "1% of the pool at 0.25%/ticket should grant 4 tickets"
    );

    await contribute(c, kp, ata, onePercent * 4); // cumulative 5%
    state = await program.account.contributor.fetch(contributorAccount);
    assert.strictEqual(
      state.ticketEnd.sub(state.ticketStart).toNumber(),
      20,
      "5% of the pool should grant the maximum 20 tickets"
    );

    try {
      await contribute(c, kp, ata, onePercent * 2); // would be cumulative 7%
      assert.fail("a cumulative contribution past 5% must be refused");
    } catch (err) {
      assertErrorIs(err, "MaximumContributionsReached", "over the per-contributor cap");
    }

    state = await program.account.contributor.fetch(contributorAccount);
    assert.strictEqual(state.ticketEnd.sub(state.ticketStart).toNumber(), 20, "tickets must not change");
    assert.strictEqual(
      await tokenBalance(c.vault),
      BigInt(onePercent * 5),
      "the rejected contribution must not reach the vault"
    );
  });

  // Draw winner

  it("pays the winner their cut and refunds the bond to the maker", async () => {
    const c = await openCampaign();
    const contributors = await fundCampaignToTarget(c, TARGET);
    const winner = contributors[0];

    await advanceSeconds(BigInt(DURATION_DAYS) * DAY + 1n);
    const slotHashEntry = await findSlotHashForContributor(c, winner);
    await seedSlotHashes(slotHashEntry);

    const makerAta = getAssociatedTokenAddressSync(c.mint, c.maker.publicKey);
    await send([createAssociatedTokenAccountInstruction(payer.publicKey, makerAta, c.maker.publicKey, c.mint)]);

    const makerSolBefore = await solBalance(c.maker.publicKey);

    await send(
      [
        await program.methods
          .drawWinner(Array.from(SECRET))
          .accountsPartial({
            maker: c.maker.publicKey,
            mintToRaise: c.mint,
            fundraiser: c.fundraiser,
            bond: c.bond,
            vault: c.vault,
            winnerWallet: winner.kp.publicKey,
            winnerContributor: winner.account,
            winnerAta: winner.ata,
            makerAta,
            slotHashes: new anchor.web3.PublicKey("SysvarS1otHashes111111111111111111111111111"),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [c.maker]
    );

    assert.strictEqual(
      await tokenBalance(winner.ata),
      BigInt(Math.floor((TARGET * REWARD_BPS) / 10_000)),
      "winner should get REWARD_BPS of the pot"
    );
    assert.strictEqual(
      await tokenBalance(makerAta),
      BigInt(TARGET - Math.floor((TARGET * REWARD_BPS) / 10_000)),
      "maker should get the remaining pot"
    );
    assert.strictEqual(await solBalance(c.bond), 0n, "bond should be fully drained");
    assert.isAbove(
      Number(await solBalance(c.maker.publicKey)),
      Number(makerSolBefore),
      "maker should receive the bond refund on a successful reveal"
    );
  });

  it("refuses a draw before the contribution window has closed", async () => {
    const c = await openCampaign();
    const contributors = await fundCampaignToTarget(c, TARGET);
    const winner = contributors[0];

    await seedSlotHashes(Buffer.alloc(32, 1));
    const makerAta = getAssociatedTokenAddressSync(c.mint, c.maker.publicKey);
    await send([createAssociatedTokenAccountInstruction(payer.publicKey, makerAta, c.maker.publicKey, c.mint)]);

    try {
      await send(
        [
          await program.methods
            .drawWinner(Array.from(SECRET))
            .accountsPartial({
              maker: c.maker.publicKey,
              mintToRaise: c.mint,
              fundraiser: c.fundraiser,
              bond: c.bond,
              vault: c.vault,
              winnerWallet: winner.kp.publicKey,
              winnerContributor: winner.account,
              winnerAta: winner.ata,
              makerAta,
              slotHashes: new anchor.web3.PublicKey("SysvarS1otHashes111111111111111111111111111"),
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        ],
        [c.maker]
      );
      assert.fail("draw must be refused while the contribution window is still open");
    } catch (err) {
      assertErrorIs(err, "WindowStillOpen", "the draw should be refused before the window closes");
    }
  });

  it("refuses a reveal whose secret does not match the committed hash", async () => {
    const c = await openCampaign();
    const contributors = await fundCampaignToTarget(c, TARGET);
    const winner = contributors[0];
    await advanceSeconds(BigInt(DURATION_DAYS) * DAY + 1n);
    await seedSlotHashes(Buffer.alloc(32, 1));

    const makerAta = getAssociatedTokenAddressSync(c.mint, c.maker.publicKey);
    await send([createAssociatedTokenAccountInstruction(payer.publicKey, makerAta, c.maker.publicKey, c.mint)]);

    try {
      await send(
        [
          await program.methods
            .drawWinner(Array.from(WRONG_SECRET))
            .accountsPartial({
              maker: c.maker.publicKey,
              mintToRaise: c.mint,
              fundraiser: c.fundraiser,
              bond: c.bond,
              vault: c.vault,
              winnerWallet: winner.kp.publicKey,
              winnerContributor: winner.account,
              winnerAta: winner.ata,
              makerAta,
              slotHashes: new anchor.web3.PublicKey("SysvarS1otHashes111111111111111111111111111"),
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        ],
        [c.maker]
      );
      assert.fail("a secret that doesn't hash to reveal_hash must be rejected");
    } catch (err) {
      assertErrorIs(err, "RevealHashMismatch", "wrong secret should be rejected");
    }
  });

  it("refuses to pay an account that isn't actually holding the winning ticket", async () => {
    const c = await openCampaign();
    const contributors = await fundCampaignToTarget(c, TARGET);
    const realWinner = contributors[0];
    const impostor = contributors[1];

    await advanceSeconds(BigInt(DURATION_DAYS) * DAY + 1n);
    const slotHashEntry = await findSlotHashForContributor(c, realWinner);
    await seedSlotHashes(slotHashEntry);

    const makerAta = getAssociatedTokenAddressSync(c.mint, c.maker.publicKey);
    await send([createAssociatedTokenAccountInstruction(payer.publicKey, makerAta, c.maker.publicKey, c.mint)]);

    try {
      await send(
        [
          await program.methods
            .drawWinner(Array.from(SECRET))
            .accountsPartial({
              maker: c.maker.publicKey,
              mintToRaise: c.mint,
              fundraiser: c.fundraiser,
              bond: c.bond,
              vault: c.vault,
              winnerWallet: impostor.kp.publicKey,
              winnerContributor: impostor.account,
              winnerAta: impostor.ata,
              makerAta,
              slotHashes: new anchor.web3.PublicKey("SysvarS1otHashes111111111111111111111111111"),
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        ],
        [c.maker]
      );
      assert.fail("paying an account outside the winning ticket range must be refused");
    } catch (err) {
      assertErrorIs(err, "NotTheWinner", "the impostor should be rejected");
    }
  });

  
  // No-reveal penalty path

  it("refuses reveal before the full 26h window (2h reveal + 24h grace) has passed", async () => {
    const c = await openCampaign();
    const contributors = await fundCampaignToTarget(c, TARGET);
    const target = contributors[0];

    await advanceSeconds(BigInt(DURATION_DAYS) * DAY + REVEAL_WINDOW_SECS + 1n);

    try {
      await send(
        [
          await program.methods
            .claimPenalty()
            .accountsPartial({
              contributor: target.kp.publicKey,
              maker: c.maker.publicKey,
              mintToRaise: c.mint,
              fundraiser: c.fundraiser,
              bond: c.bond,
              contributorAccount: target.account,
              contributorAta: target.ata,
              vault: c.vault,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        ],
        [target.kp]
      );
      assert.fail("reclaim must be refused before the full 26h window has passed");
    } catch (err) {
      assertErrorIs(err, "DeadlineNotPassed", "reclaim should be refused before the grace period ends");
    }
  });

  it("refunds the contributor and forfeits a bond share once the maker goes dark", async () => {
    const c = await openCampaign();
    const contributors = await fundCampaignToTarget(c, TARGET);
    const target = contributors[0];

    await advanceSeconds(
      BigInt(DURATION_DAYS) * DAY + REVEAL_WINDOW_SECS + PENALTY_DELAY_SECS + 1n
    );

    const contributorSolBefore = await solBalance(target.kp.publicKey);

    try {
      await send(
        [
          await program.methods
            .claimPenalty()
            .accountsPartial({
              contributor: target.kp.publicKey,
              maker: c.maker.publicKey,
              mintToRaise: c.mint,
              fundraiser: c.fundraiser,
              bond: c.bond,
              contributorAccount: target.account,
              contributorAta: target.ata,
              vault: c.vault,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        ],
        [target.kp]
      );
    } catch (err) {
      assert.fail(`reclaim_no_reveal should have succeeded, got ${errorCodeOf(err)}`);
    }

    const perContributor = Math.floor(TARGET * 0.05);
    assert.strictEqual(
      await tokenBalance(target.ata),
      BigInt(perContributor),
      "contributor should get their full contribution back"
    );

    const accountStillExists = await context.banksClient.getAccount(target.account);
    assert.isNull(accountStillExists, "contributor account should be closed");

    assert.isAbove(
      Number(await solBalance(target.kp.publicKey)),
      Number(contributorSolBefore),
      "contributor should also receive a share of the forfeited bond"
    );
  });

  it("permanently blocks reclaim_no_reveal once a winner has actually been drawn", async () => {
    const c = await openCampaign();
    const contributors = await fundCampaignToTarget(c, TARGET);
    const winner = contributors[0];

    await advanceSeconds(BigInt(DURATION_DAYS) * DAY + 1n);
    const slotHashEntry = await findSlotHashForContributor(c, winner);
    await seedSlotHashes(slotHashEntry);

    const makerAta = getAssociatedTokenAddressSync(c.mint, c.maker.publicKey);
    await send([createAssociatedTokenAccountInstruction(payer.publicKey, makerAta, c.maker.publicKey, c.mint)]);

    await send(
      [
        await program.methods
          .drawWinner(Array.from(SECRET))
          .accountsPartial({
            maker: c.maker.publicKey,
            mintToRaise: c.mint,
            fundraiser: c.fundraiser,
            bond: c.bond,
            vault: c.vault,
            winnerWallet: winner.kp.publicKey,
            winnerContributor: winner.account,
            winnerAta: winner.ata,
            makerAta,
            slotHashes: new anchor.web3.PublicKey("SysvarS1otHashes111111111111111111111111111"),
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [c.maker]
    );

    await advanceSeconds(REVEAL_WINDOW_SECS + PENALTY_DELAY_SECS + 1n);

    try {
      await send(
        [
          await program.methods
            .claimPenalty()
            .accountsPartial({
              contributor: winner.kp.publicKey,
              maker: c.maker.publicKey,
              mintToRaise: c.mint,
              fundraiser: c.fundraiser,
              bond: c.bond,
              contributorAccount: winner.account,
              contributorAta: winner.ata,
              vault: c.vault,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction(),
        ],
        [winner.kp]
      );
      assert.fail("reclaim_no_reveal must be blocked once winner_drawn is true");
    } catch (err) {
      assertErrorIs(err, "AccountNotInitialized", "a drawn winner should permanently block the fallback path");
    }
  });
});