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
 * Option C: every contribution mints a one-of-one receipt NFT, and whoever holds
 * that NFT can redeem it for the contribution recorded against it.
 *
 * Bankrun, because a refund is only legal after the deadline and `anchor test`
 * cannot move the clock.
 */
describe("fundraiser — receipt NFTs (bankrun)", () => {
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

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

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
    if (!account) return null;
    return {
      ...account,
      data: Buffer.from(account.data),
      owner: new anchor.web3.PublicKey(account.owner),
    } as any;
  };

  const tokenBalance = async (address: anchor.web3.PublicKey): Promise<bigint> => {
    const account = await rawAccount(address);
    assert.isNotNull(account, "token account should exist");
    return unpackAccount(address, account).amount;
  };

  const mintInfo = async (address: anchor.web3.PublicKey) => {
    const account = await rawAccount(address);
    assert.isNotNull(account, "mint should exist");
    return unpackMint(address, account);
  };

  /** Program error name, whether it is one of ours or one of Anchor's. */
  const errorCodeOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;

    const text = `${err?.message ?? ""} ${JSON.stringify(err?.logs ?? [])}`;
    const byName = text.match(/Error Code: (\w+)/);
    if (byName) return byName[1];

    const byNumber = text.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (byNumber) {
      const code = parseInt(byNumber[1], 16);
      const ours = (program.idl.errors ?? []).find((e: any) => e.code === code);
      if (ours) return ours.name;
      const anchors = Object.entries(anchor.LangErrorCode).find(([, n]) => n === code);
      if (anchors) return anchors[0];
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

  const u64 = (n: number) => new anchor.BN(n).toArrayLike(Buffer, "le", 8);

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  /** Receipt #n of a campaign: its claim record, its NFT mint, and a holder's token account for it. */
  const receiptOf = (c: Campaign, n: number, holder: anchor.web3.PublicKey) => {
    const [receipt] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), c.fundraiser.toBuffer(), u64(n)],
      program.programId
    );
    const [receiptMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt_mint"), c.fundraiser.toBuffer(), u64(n)],
      program.programId
    );
    const holderAta = getAssociatedTokenAddressSync(receiptMint, holder);
    return { receipt, receiptMint, holderAta };
  };

  /** A fresh mint, a funded payer holding 10 contributions' worth, and an open campaign. */
  const openCampaign = async (): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;

    const rent = await context.banksClient.getRent();
    const mintRent = Number(rent.minimumBalance(BigInt(MINT_SIZE)));
    const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

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
        createAssociatedTokenAccountInstruction(payer.publicKey, payerAta, payer.publicKey, mint),
        createMintToInstruction(mint, payerAta, payer.publicKey, 10 * CONTRIBUTION),
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

  /** The payer contributes; the program derives receipt #issue_count itself. */
  const contribute = async (c: Campaign, amount: number) => {
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), c.fundraiser.toBuffer(), payer.publicKey.toBuffer()],
      program.programId
    );
    await send([
      await program.methods
        .contribute(new anchor.BN(amount))
        .accountsPartial({
          contributor: payer.publicKey,
          mintToRaise: c.mint,
          fundraiser: c.fundraiser,
          contributorAccount,
          contributorAta: getAssociatedTokenAddressSync(c.mint, payer.publicKey),
          vault: c.vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction(),
    ]);
  };

  /**
   * `signer` redeems receipt #n, presenting `holderAta` as proof of possession.
   * `holderAta` defaults to the signer's own token account for receipt #n's mint.
   */
  const refund = async (
    c: Campaign,
    n: number,
    signer: anchor.web3.Keypair,
    holderAta?: anchor.web3.PublicKey
  ) => {
    const r = receiptOf(c, n, signer.publicKey);
    const signers = signer.publicKey.equals(payer.publicKey) ? [] : [signer];
    await send(
      [
        await program.methods
          .refund(new anchor.BN(n))
          .accountsPartial({
            contributor: signer.publicKey,
            maker: c.maker.publicKey,
            mintToRaise: c.mint,
            fundraiser: c.fundraiser,
            receipt: r.receipt,
            receiptMint: r.receiptMint,
            holderReceiptAta: holderAta ?? r.holderAta,
            contributorAta: getAssociatedTokenAddressSync(c.mint, signer.publicKey),
            vault: c.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
      ],
      signers
    );
  };

  /** Hands receipt #n from the payer to `to`, creating the accounts `to` needs to hold and redeem it. */
  const giveReceipt = async (c: Campaign, n: number, to: anchor.web3.PublicKey) => {
    const from = receiptOf(c, n, payer.publicKey);
    const dest = receiptOf(c, n, to);
    const toFundsAta = getAssociatedTokenAddressSync(c.mint, to);
    const ixs = [
      createAssociatedTokenAccountInstruction(payer.publicKey, dest.holderAta, to, from.receiptMint),
      createTransferInstruction(from.holderAta, dest.holderAta, payer.publicKey, 1),
    ];
    if (!(await rawAccount(toFundsAta))) {
      ixs.unshift(createAssociatedTokenAccountInstruction(payer.publicKey, toFundsAta, to, c.mint));
    }
    await send(ixs);
  };

  // ------------------------------------------------------------------
  // Minting
  // ------------------------------------------------------------------

  it("mints a one-of-one receipt NFT that records the contribution", async () => {
    const c = await openCampaign();
    await contribute(c, CONTRIBUTION);

    const r = receiptOf(c, 0, payer.publicKey);

    assert.strictEqual(await tokenBalance(r.holderAta), 1n, "the contributor should hold the receipt NFT");

    const mint = await mintInfo(r.receiptMint);
    assert.strictEqual(mint.supply, 1n, "exactly one receipt should exist");
    assert.strictEqual(mint.decimals, 0, "a receipt is indivisible");
    assert.isNull(mint.mintAuthority, "the mint authority must be removed so no second copy can be minted");

    const receipt = await program.account.receipt.fetch(r.receipt);
    assert.strictEqual(receipt.amount.toString(), String(CONTRIBUTION), "the receipt should record the contribution");

    const fundraiser = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(fundraiser.issueCount.toString(), "1", "issue_count should move on to the next receipt");
  });

  it("gives every contribution its own receipt, even from the same wallet", async () => {
    const c = await openCampaign();
    await contribute(c, CONTRIBUTION);
    await contribute(c, 2 * CONTRIBUTION);

    const first = receiptOf(c, 0, payer.publicKey);
    const second = receiptOf(c, 1, payer.publicKey);

    assert.strictEqual(
      (await program.account.receipt.fetch(first.receipt)).amount.toString(),
      String(CONTRIBUTION),
      "receipt #0 must keep the first contribution's amount"
    );
    assert.strictEqual(
      (await program.account.receipt.fetch(second.receipt)).amount.toString(),
      String(2 * CONTRIBUTION),
      "receipt #1 must record only the second contribution"
    );
    assert.strictEqual(await tokenBalance(first.holderAta), 1n);
    assert.strictEqual(await tokenBalance(second.holderAta), 1n);

    const fundraiser = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(fundraiser.issueCount.toString(), "2");
  });

  // ------------------------------------------------------------------
  // Redeeming
  // ------------------------------------------------------------------

  it("refund burns the receipt, closes its claim record and pays its amount", async () => {
    const c = await openCampaign();
    await contribute(c, CONTRIBUTION);
    await advanceDays(8n);

    const payerFunds = getAssociatedTokenAddressSync(c.mint, payer.publicKey);
    const before = await tokenBalance(payerFunds);

    await refund(c, 0, payer);

    const r = receiptOf(c, 0, payer.publicKey);
    assert.strictEqual(await tokenBalance(r.holderAta), 0n, "the receipt NFT should be burned");
    assert.strictEqual((await mintInfo(r.receiptMint)).supply, 0n, "no receipt should remain in circulation");
    assert.isNull(await rawAccount(r.receipt), "the claim record should be closed");
    assert.strictEqual(
      await tokenBalance(payerFunds),
      before + BigInt(CONTRIBUTION),
      "the holder should get the receipt's amount back"
    );
    assert.strictEqual(await tokenBalance(c.vault), 0n, "the vault should be empty");
  });

  it("pays whoever holds the receipt: a buyer can redeem it", async () => {
    const c = await openCampaign();
    await contribute(c, CONTRIBUTION);

    const bob = anchor.web3.Keypair.generate();
    await giveReceipt(c, 0, bob.publicKey);
    await advanceDays(8n);

    await refund(c, 0, bob);

    assert.strictEqual(
      await tokenBalance(getAssociatedTokenAddressSync(c.mint, bob.publicKey)),
      BigInt(CONTRIBUTION),
      "Bob holds the receipt, so Bob gets the refund"
    );
    assert.strictEqual(await tokenBalance(receiptOf(c, 0, bob.publicKey).holderAta), 0n, "Bob's receipt should be burned");
  });

  it("refuses the original contributor once they have given the receipt away", async () => {
    const c = await openCampaign();
    await contribute(c, CONTRIBUTION);

    const bob = anchor.web3.Keypair.generate();
    await giveReceipt(c, 0, bob.publicKey);
    await advanceDays(8n);

    try {
      await refund(c, 0, payer);
      assert.fail("the contributor no longer holds the receipt, so the refund must be refused");
    } catch (err) {
      assertErrorIs(err, "NoReceipt", "an empty token account is not proof of possession");
    }

    assert.strictEqual(await tokenBalance(c.vault), BigInt(CONTRIBUTION), "nothing may leave the vault");
  });

  it("refuses to redeem the same receipt twice", async () => {
    const c = await openCampaign();
    await contribute(c, CONTRIBUTION);
    await contribute(c, CONTRIBUTION); // so the vault still holds something to steal
    await advanceDays(8n);

    await refund(c, 0, payer);

    // A byte-identical transaction in the same block is dropped as a duplicate before the
    // program ever sees it. Move to the next slot so the program itself has to refuse it.
    const clock = await context.banksClient.getClock();
    context.warpToSlot(clock.slot + 1n);

    try {
      await refund(c, 0, payer);
      assert.fail("receipt #0 has already been redeemed");
    } catch (err) {
      assertErrorIs(err, "AccountNotInitialized", "the claim record was closed by the first refund");
    }

    assert.strictEqual(await tokenBalance(c.vault), BigInt(CONTRIBUTION), "only receipt #1 should remain in the vault");
  });

  it("refuses to pair a small receipt with someone else's larger claim", async () => {
    const c = await openCampaign();
    await contribute(c, CONTRIBUTION);       // receipt #0: the payer's small one
    await contribute(c, 2 * CONTRIBUTION);   // receipt #1: the "whale's" (per-wallet cap is 10% of target)

    const bob = anchor.web3.Keypair.generate();
    await giveReceipt(c, 0, bob.publicKey);  // Bob legitimately holds the small receipt
    await advanceDays(8n);

    // Bob asks for claim #1 but presents his token account for NFT #0.
    try {
      await refund(c, 1, bob, receiptOf(c, 0, bob.publicKey).holderAta);
      assert.fail("Bob's NFT is receipt #0, so claim #1 must be refused");
    } catch (err) {
      assertErrorIs(err, "ConstraintTokenMint", "the NFT presented must be the one derived from the claimed issue number");
    }

    assert.strictEqual(await tokenBalance(c.vault), BigInt(3 * CONTRIBUTION), "nothing may leave the vault");
  });
});
