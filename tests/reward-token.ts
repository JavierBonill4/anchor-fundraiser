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
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { assert, AssertionError } from "chai";

/**
 * Option D: reward tokens minted on contribute, burned on refund.
 * Runs on solana-bankrun so the clock can be moved (refund needs a closed window).
 */
describe("fundraiser — reward token (bankrun)", () => {
  const DECIMALS = 6; // the mint being raised
  const ONE_TOKEN = 1_000_000;
  const TARGET = 30 * ONE_TOKEN; // per-wallet cap = 10% = 3 tokens
  const DURATION_DAYS = 7;
  const DAY = 86_400n;
  const SLOTS_PER_DAY = 216_000n;

  // Must mirror constants.rs: 100 whole reward tokens per whole token, 9 reward decimals.
  const REWARD_PER_TOKEN = 100n;
  const REWARD_DECIMALS = 9n;
  const rewardFor = (amount: bigint) =>
    (amount * REWARD_PER_TOKEN * 10n ** REWARD_DECIMALS) / 10n ** BigInt(DECIMALS);

  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Fundraiser>;
  let payer: anchor.web3.Keypair; // also our contributor
  let mint: anchor.web3.PublicKey; // the mint being raised
  let contributorAta: anchor.web3.PublicKey;

  before(async () => {
    context = await startAnchor("", [], []);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    const idl = require("../target/idl/fundraiser.json");
    program = new anchor.Program<Fundraiser>(idl, provider);
    payer = context.payer;

    // one shared mint to raise, 100 tokens for the contributor
    const mintKeypair = anchor.web3.Keypair.generate();
    mint = mintKeypair.publicKey;
    const rent = await context.banksClient.getRent();
    contributorAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
    await send(
      [
        anchor.web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, DECIMALS, payer.publicKey, null),
        createAssociatedTokenAccountInstruction(payer.publicKey, contributorAta, payer.publicKey, mint),
        createMintToInstruction(mint, contributorAta, payer.publicKey, 100 * ONE_TOKEN),
      ],
      [mintKeypair]
    );
      // ---------- 5 · abuse: someone else's reward mint --------------------------

  it("abuse: a contribution naming the wrong reward mint is refused", async () => {
    const c = await openCampaign();

    // A perfectly valid mint that is NOT this campaign's reward mint.
    const fake = anchor.web3.Keypair.generate();
    const rent = await context.banksClient.getRent();
    await send(
      [
        anchor.web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: fake.publicKey,
          space: MINT_SIZE,
          lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(fake.publicKey, 9, payer.publicKey, null),
      ],
      [fake]
    );
    const fakeRewardAta = getAssociatedTokenAddressSync(fake.publicKey, payer.publicKey);

    const ix = await program.methods
      .contribute(new anchor.BN(ONE_TOKEN))
      .accountsPartial({
        contributor: payer.publicKey,
        mintToRaise: mint,
        fundraiser: c.fundraiser,
        contributorAccount: c.contributorAccount,
        contributorAta,
        vault: c.vault,
        rewardMint: fake.publicKey, // <- not the campaign's reward mint
        contributorRewardAta: fakeRewardAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .instruction();

    try {
      await send([ix]);
      assert.fail("a foreign reward mint must be refused");
    } catch (err) {
      assertErrorIs(err, "InvalidRewardMint", "the fundraiser only accepts its own reward mint");
    }
    assert.strictEqual(await balanceOf(c.vault), 0n, "no money moved");
    assert.strictEqual(await supplyOf(c.rewardMint), 0n, "nothing was minted");
  });

  // ---------- 6 · boundary: the wallet cap -----------------------------------

  it("boundary: exactly the wallet cap earns rewards, one token over earns none", async () => {
    const c = await openCampaign(); // target 30 tokens => cap is 3 tokens per wallet

    await send([await c.contributeIx(3 * ONE_TOKEN)]); // exactly at the cap: allowed
    assert.strictEqual(await balanceOf(c.contributorRewardAta), 300_000_000_000n);

    try {
      await send([await c.contributeIx(ONE_TOKEN)]); // one token over the cap
      assert.fail("a contribution over the wallet cap must be refused");
    } catch (err) {
      assertErrorIs(err, "MaximumContributionsReached", "over the per-wallet cap");
    }
    assert.strictEqual(await balanceOf(c.contributorRewardAta), 300_000_000_000n, "a refused contribution mints nothing");
    const contributor = await program.account.contributor.fetch(c.contributorAccount);
    assert.strictEqual(contributor.rewardsMinted.toString(), "300000000000", "state did not move either");
  });

  // ---------- 7 · abuse: contributing after the window closed ----------------

  it("abuse: no rewards can be earned after the window closes", async () => {
    const c = await openCampaign();
    await send([await c.contributeIx(ONE_TOKEN)]);

    await advanceDays(8n);

    try {
      await send([await c.contributeIx(ONE_TOKEN)]);
      assert.fail("a contribution after the deadline must be refused");
    } catch (err) {
      assertErrorIs(err, "FundraiserEnded", "the window is closed");
    }
    assert.strictEqual(await balanceOf(c.contributorRewardAta), 100_000_000_000n, "still only the first reward");
    assert.strictEqual(await supplyOf(c.rewardMint), 100_000_000_000n);
  });
  });

  // ---------- helpers ------------------------------------------------------

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

  const rawAccount = async (address: anchor.web3.PublicKey) => {
    const account = await context.banksClient.getAccount(address);
    return account
      ? ({ ...account, data: Buffer.from(account.data), owner: new anchor.web3.PublicKey(account.owner) } as any)
      : null;
  };

  /** Token balance, or 0n if the account does not exist yet. */
  const balanceOf = async (address: anchor.web3.PublicKey): Promise<bigint> => {
    const acc = await rawAccount(address);
    return acc ? unpackAccount(address, acc).amount : 0n;
  };

  const supplyOf = async (address: anchor.web3.PublicKey): Promise<bigint> => {
    const acc = await rawAccount(address);
    assert.isNotNull(acc, "mint should exist");
    return unpackMint(address, acc).supply;
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
      return known ? known.name : `custom error ${code}`;
    }
    return text.slice(0, 300);
  };

  const assertErrorIs = (err: any, expected: string, why: string) => {
    const actual = errorCodeOf(err);
    assert.strictEqual(actual.toLowerCase(), expected.toLowerCase(), `${why} (expected ${expected}, got ${actual})`);
  };

  /** Opens a fresh campaign (new maker => new fundraiser, vault and reward mint) and returns every address. */
  const openCampaign = async () => {
    const maker = anchor.web3.Keypair.generate();
    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const [rewardMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward"), fundraiser.toBuffer()],
      program.programId
    );
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), payer.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    const contributorRewardAta = getAssociatedTokenAddressSync(rewardMint, payer.publicKey);

    await send(
      [
        // the maker pays rent for fundraiser + vault + reward mint; bankrun has no airdrop
        anchor.web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: maker.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        }),
        await program.methods
          .initialize(new anchor.BN(TARGET), DURATION_DAYS)
          .accountsPartial({
            maker: maker.publicKey,
            mintToRaise: mint,
            fundraiser,
            vault,
            rewardMint,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [maker]
    );

    const contributeIx = (amount: number) =>
      program.methods
        .contribute(new anchor.BN(amount))
        .accountsPartial({
          contributor: payer.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount,
          contributorAta,
          vault,
          rewardMint,
          contributorRewardAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .instruction();

    const refundIx = () =>
      program.methods
        .refund()
        .accountsPartial({
          contributor: payer.publicKey,
          maker: maker.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount,
          contributorAta,
          vault,
          rewardMint,
          contributorRewardAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction();

    return { maker, fundraiser, rewardMint, contributorAccount, vault, contributorRewardAta, contributeIx, refundIx };
  };

  // ---------- 1 · happy path ------------------------------------------------

  it("mints the reward on contribute and records it in state", async () => {
    const c = await openCampaign();

    const fr = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(fr.rewardMint.toBase58(), c.rewardMint.toBase58(), "campaign must remember its reward mint");

    await send([await c.contributeIx(ONE_TOKEN)]);

    const expected = rewardFor(BigInt(ONE_TOKEN)); // 100 whole reward tokens
    assert.strictEqual(expected, 100_000_000_000n);
    assert.strictEqual(await balanceOf(c.contributorRewardAta), expected, "contributor holds the reward");
    assert.strictEqual(await supplyOf(c.rewardMint), expected, "supply equals what was minted");

    const contributor = await program.account.contributor.fetch(c.contributorAccount);
    assert.strictEqual(contributor.rewardsMinted.toString(), expected.toString(), "state tracks what a refund must burn");
    assert.strictEqual(await balanceOf(c.vault), BigInt(ONE_TOKEN), "the money is in the vault");
  });

  // ---------- 2 · boundary --------------------------------------------------

  it("boundary: one raw unit under a whole token mints nothing, exactly one whole token mints exactly 100", async () => {
    const c = await openCampaign();

    try {
      await send([await c.contributeIx(ONE_TOKEN - 1)]);
      assert.fail("a contribution below one whole token must be refused");
    } catch (err) {
      assertErrorIs(err, "ContributionTooSmall", "one unit under the minimum");
    }
    assert.strictEqual(await balanceOf(c.contributorRewardAta), 0n, "a refused contribution must not mint");
    assert.strictEqual(await supplyOf(c.rewardMint), 0n);

    await send([await c.contributeIx(ONE_TOKEN)]);
    assert.strictEqual(await balanceOf(c.contributorRewardAta), 100_000_000_000n, "exactly at the minimum it mints");

    // a second, non-round contribution accumulates instead of overwriting
    await send([await c.contributeIx(1_500_000)]);
    assert.strictEqual(await balanceOf(c.contributorRewardAta), 250_000_000_000n);
    const contributor = await program.account.contributor.fetch(c.contributorAccount);
    assert.strictEqual(contributor.rewardsMinted.toString(), "250000000000");
  });

  // ---------- 3 · abuse: paid for nothing ------------------------------------

  it("abuse: cannot refund while holding fewer rewards than were minted; refund burns them", async () => {
    const c = await openCampaign();
    await send([await c.contributeIx(ONE_TOKEN)]);
    const minted = rewardFor(BigInt(ONE_TOKEN));

    // Move the reward tokens to another wallet, hoping to keep them AND get the money back.
    const other = anchor.web3.Keypair.generate();
    const otherRewardAta = getAssociatedTokenAddressSync(c.rewardMint, other.publicKey);
    await send([
      createAssociatedTokenAccountInstruction(payer.publicKey, otherRewardAta, other.publicKey, c.rewardMint),
      createTransferInstruction(c.contributorRewardAta, otherRewardAta, payer.publicKey, minted),
    ]);
    assert.strictEqual(await balanceOf(c.contributorRewardAta), 0n);

    await advanceDays(8n); // window closed, target (30) not met: refund is otherwise legal

    try {
      await send([await c.refundIx()]);
      assert.fail("refund must be refused when the rewards are not returned");
    } catch (err) {
      assertErrorIs(err, "RewardsNotHeld", "the rewards left the wallet");
    }
    assert.strictEqual(await balanceOf(c.vault), BigInt(ONE_TOKEN), "nothing left the vault");

    // Give them back: now the refund goes through and the rewards are destroyed.
    await send([createTransferInstruction(otherRewardAta, c.contributorRewardAta, other.publicKey, minted)], [other]);
    await send([await c.refundIx()]);

    assert.strictEqual(await balanceOf(c.vault), 0n, "the vault paid out");
    assert.strictEqual(await balanceOf(c.contributorRewardAta), 0n, "the rewards were burned");
    assert.strictEqual(await supplyOf(c.rewardMint), 0n, "burned, not parked: total supply is back to zero");
    assert.isNull(await rawAccount(c.contributorAccount), "the contributor account closed");
  });

  // ---------- 4 · abuse: mint it yourself ------------------------------------

  it("abuse: a contributor cannot mint reward tokens directly", async () => {
    const c = await openCampaign();
    await send([await c.contributeIx(ONE_TOKEN)]); // creates their reward ATA

    try {
      await send([createMintToInstruction(c.rewardMint, c.contributorRewardAta, payer.publicKey, 1)]);
      assert.fail("only the fundraiser PDA may mint the reward");
    } catch (err) {
      // SPL Token's OwnerMismatch, error 4: the signer is not the mint authority
      assertErrorIs(err, "custom error 4", "the contributor is not the mint authority");
    }
    assert.strictEqual(await supplyOf(c.rewardMint), 100_000_000_000n, "supply unchanged");
  });
});