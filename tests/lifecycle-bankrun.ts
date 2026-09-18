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
import { fundraiserPda, contributorPda } from "./pda";

/**
 * Campaign lifecycle.
 *
 * Before this feature a maker got one campaign per mint, ever. On the success
 * path `check_contributions` closed the Fundraiser but left the vault ATA
 * standing, and `initialize` creates the vault with `init`; on the failure path
 * nothing closed either account. Both made the second `initialize` fail on an
 * address that was already occupied.
 *
 * Now the fundraiser seeds carry an id, `check_contributions` closes the vault
 * it just emptied, and `close_campaign` is a permissionless crank that winds up
 * a campaign that missed its target.
 *
 * Bankrun rather than a validator: it needs no wallet, and it can move the clock.
 */
describe("fundraiser — campaign lifecycle", () => {
  const TARGET = 30_000_000; // 30 tokens at 6 decimals
  const CONTRIBUTION = 3_000_000; // exactly the 10% per-contributor cap
  const DAY = 86_400n;
  const SLOTS_PER_DAY = 216_000n;

  let context: ProgramTestContext;
  let program: Program<Fundraiser>;
  let payer: anchor.web3.Keypair;

  // A fresh bank per test, so one test's clock warp cannot reach another.
  beforeEach(async () => {
    context = await startAnchor("", [], []);
    const provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    program = new anchor.Program<Fundraiser>(require("../target/idl/fundraiser.json"), provider);
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

  /** The Anchor error name behind a bankrun rejection, which arrives as a string. */
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
    return text.slice(0, 300);
  };

  const assertErrorIs = (err: any, expected: string, why: string) => {
    const text = textOf(err);
    // A byte-identical transaction on an unchanged blockhash is refused as a
    // duplicate, which would make any of these assertions pass for the wrong
    // reason.
    assert.notMatch(
      text,
      /already processed|AlreadyProcessed|blockhash not found/i,
      `${why} — but the bank refused it as a duplicate, not on its merits: ${text.slice(0, 200)}`
    );
    const actual = errorCodeOf(err);
    assert.strictEqual(
      actual.toLowerCase(),
      expected.toLowerCase(),
      `${why} (expected ${expected}, got ${actual})`
    );
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
    assert.isNotNull(account, `token account ${address.toBase58()} should exist`);
    return unpackAccount(address, {
      ...account!,
      data: Buffer.from(account!.data),
      owner: new anchor.web3.PublicKey(account!.owner),
    } as any).amount;
  };

  const lamports = async (address: anchor.web3.PublicKey): Promise<bigint> =>
    BigInt((await context.banksClient.getAccount(address))?.lamports ?? 0);

  /** A funded maker, a fresh 6-decimal mint, and a contributor ATA with tokens. */
  const freshMakerAndMint = async () => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;
    const contributorAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

    const rent = await context.banksClient.getRent();
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
          lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
        createAssociatedTokenAccountInstruction(payer.publicKey, contributorAta, payer.publicKey, mint),
        createMintToInstruction(mint, contributorAta, payer.publicKey, 10 * TARGET),
      ],
      [mintKeypair]
    );
    return { maker, mint, contributorAta };
  };

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    id: number;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
    makerAta: anchor.web3.PublicKey;
    contributorAta: anchor.web3.PublicKey;
    contributorAccount: anchor.web3.PublicKey;
  };

  const openCampaign = async (
    maker: anchor.web3.Keypair,
    mint: anchor.web3.PublicKey,
    contributorAta: anchor.web3.PublicKey,
    id: number,
    durationDays: number
  ): Promise<Campaign> => {
    const fundraiser = fundraiserPda(program.programId, maker.publicKey, id);
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await send(
      [
        await program.methods
          .initialize(new anchor.BN(id), new anchor.BN(TARGET), durationDays)
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

    const { timeStarted } = await program.account.fundraiser.fetch(fundraiser);
    return {
      maker,
      mint,
      id,
      fundraiser,
      vault,
      makerAta: getAssociatedTokenAddressSync(mint, maker.publicKey),
      contributorAta,
      contributorAccount: contributorPda(program.programId, fundraiser, payer.publicKey, timeStarted),
    };
  };

  const contributeIx = (c: Campaign, amount: number) =>
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

  const refundIx = (c: Campaign) =>
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

  const checkContributionsIx = (c: Campaign) =>
    program.methods
      .checkContributions()
      .accountsPartial({
        maker: c.maker.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        vault: c.vault,
        makerAta: c.makerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .instruction();

  /** Note the caller: a third party, not the maker and not a contributor. */
  const closeCampaignIx = (c: Campaign, caller: anchor.web3.PublicKey) =>
    program.methods
      .closeCampaign()
      .accountsPartial({
        caller,
        maker: c.maker.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

  /** Top the vault up to the target without going through `contribute`. */
  const topUpVault = (c: Campaign, amount: number) =>
    send([createMintToInstruction(c.mint, c.vault, payer.publicKey, amount)]);

  // ------------------------------------------------------------------
  // The happy paths: a campaign can now be followed by another
  // ------------------------------------------------------------------

  it("closes the vault on success, so the maker can run another campaign", async () => {
    const { maker, mint, contributorAta } = await freshMakerAndMint();
    const first = await openCampaign(maker, mint, contributorAta, 1, 7);

    await topUpVault(first, TARGET);
    await send([await checkContributionsIx(first)], [maker]);

    assert.isNull(
      await context.banksClient.getAccount(first.fundraiser),
      "the fundraiser should be closed"
    );
    assert.isNull(
      await context.banksClient.getAccount(first.vault),
      "the vault should be closed too — this is the whole feature"
    );

    // A second campaign, same maker, same mint, different id.
    const second = await openCampaign(maker, mint, contributorAta, 2, 7);
    assert.isNotNull(
      await context.banksClient.getAccount(second.fundraiser),
      "a second campaign for the same maker and mint must now be possible"
    );
    assert.notStrictEqual(
      first.fundraiser.toBase58(),
      second.fundraiser.toBase58(),
      "the id must put the two campaigns at different addresses"
    );
  });

  it("winds up a failed campaign from a third party, and returns the rent to the maker", async () => {
    const { maker, mint, contributorAta } = await freshMakerAndMint();
    const c = await openCampaign(maker, mint, contributorAta, 1, 7);

    await send([await contributeIx(c, CONTRIBUTION)]);
    await advanceDays(8n);
    await send([await refundIx(c)]);
    assert.strictEqual(await tokenBalance(c.vault), 0n, "the contributor took their money back");

    const before = await lamports(maker.publicKey);

    // The caller is the bankrun payer: not the maker, not a contributor.
    await send([await closeCampaignIx(c, payer.publicKey)]);

    assert.isNull(await context.banksClient.getAccount(c.fundraiser), "fundraiser closed");
    assert.isNull(await context.banksClient.getAccount(c.vault), "vault closed");
    assert.isAbove(
      Number(await lamports(maker.publicKey)) - Number(before),
      0,
      "the rent goes to the maker who paid it, not to the caller who cranked it"
    );

    const again = await openCampaign(maker, mint, contributorAta, 2, 7);
    assert.isNotNull(
      await context.banksClient.getAccount(again.fundraiser),
      "and the maker can start over"
    );
  });

  // ------------------------------------------------------------------
  // The boundary: one day either side of the deadline
  // ------------------------------------------------------------------

  it("refuses to wind up a campaign whose window is still open", async () => {
    const { maker, mint, contributorAta } = await freshMakerAndMint();
    const c = await openCampaign(maker, mint, contributorAta, 1, 7);

    // Day 6 of 7: still open, even though the vault is empty.
    await advanceDays(6n);
    try {
      await send([await closeCampaignIx(c, payer.publicKey)]);
      assert.fail("close_campaign on day 6 of a 7 day campaign must be refused");
    } catch (err) {
      assertErrorIs(err, "FundraiserNotEnded", "the window has not closed yet");
    }

    // Day 7: the deadline itself is the first legal moment.
    await advanceDays(1n);
    try {
      await send([await closeCampaignIx(c, payer.publicKey)]);
    } catch (err) {
      assert.fail(`close_campaign on day 7 must be accepted, got ${errorCodeOf(err)}`);
    }
    assert.isNull(await context.banksClient.getAccount(c.fundraiser), "fundraiser closed on day 7");
  });

  // ------------------------------------------------------------------
  // The abuse case: the check the whole instruction hangs on
  // ------------------------------------------------------------------

  it("refuses to wind up a campaign whose contributors have not refunded", async () => {
    const { maker, mint, contributorAta } = await freshMakerAndMint();
    const c = await openCampaign(maker, mint, contributorAta, 1, 7);

    await send([await contributeIx(c, CONTRIBUTION)]);
    await advanceDays(8n);

    // The window has closed and the target was missed, so the only thing
    // standing between the caller and the contributor's money is the vault
    // balance check. Closing here would leave those tokens with no instruction
    // able to sign for their authority, ever.
    try {
      await send([await closeCampaignIx(c, payer.publicKey)]);
      assert.fail("close_campaign with tokens still in the vault must be refused");
    } catch (err) {
      assertErrorIs(err, "VaultNotEmpty", "the contributor has not refunded yet");
    }

    assert.strictEqual(
      await tokenBalance(c.vault),
      BigInt(CONTRIBUTION),
      "the contributor's money is untouched"
    );
    assert.isNotNull(
      await context.banksClient.getAccount(c.fundraiser),
      "and the account they need in order to refund is still there"
    );

    // Which they then do, and only then can the campaign be wound up.
    await send([await refundIx(c)]);
    await send([await closeCampaignIx(c, payer.publicKey)]);
    assert.isNull(await context.banksClient.getAccount(c.fundraiser), "wound up once it is empty");
  });

  // ------------------------------------------------------------------
  // Why `time_started` is a contributor seed
  // ------------------------------------------------------------------

  it("gives a returning contributor a fresh account when a maker reuses an id", async () => {
    const { maker, mint, contributorAta } = await freshMakerAndMint();

    const first = await openCampaign(maker, mint, contributorAta, 7, 7);
    await send([await contributeIx(first, CONTRIBUTION)]);
    await topUpVault(first, TARGET - CONTRIBUTION);
    await send([await checkContributionsIx(first)], [maker]);

    // Nothing closes a Contributor on the success path, so this one is stranded.
    assert.isNotNull(
      await context.banksClient.getAccount(first.contributorAccount),
      "the Contributor from a successful campaign is still on chain"
    );

    // One second later, the same maker reuses id 7.
    await advanceDays(1n);
    const second = await openCampaign(maker, mint, contributorAta, 7, 7);
    assert.notStrictEqual(
      first.contributorAccount.toBase58(),
      second.contributorAccount.toBase58(),
      "time_started must keep the two campaigns' contributor accounts apart"
    );

    await send([await contributeIx(second, CONTRIBUTION)]);
    const fresh = await program.account.contributor.fetch(second.contributorAccount);
    assert.strictEqual(
      fresh.amount.toString(),
      String(CONTRIBUTION),
      "the returning contributor starts from zero, not from the stranded balance"
    );
  });

  // ------------------------------------------------------------------
  // Unchanged, and still worth asserting
  // ------------------------------------------------------------------

  it("still pays out a vault that never saw a contribution, with current_amount at 0", async () => {
    const { maker, mint, contributorAta } = await freshMakerAndMint();
    const c = await openCampaign(maker, mint, contributorAta, 1, 7);

    await topUpVault(c, TARGET);

    const state = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(
      state.currentAmount.toString(),
      "0",
      "nothing went through contribute, so the program's own counter reads 0"
    );

    await send([await checkContributionsIx(c)], [maker]);
    assert.strictEqual(
      await tokenBalance(c.makerAta),
      BigInt(TARGET),
      "the guards read vault.amount, so a directly funded vault still pays out"
    );
  });
});
