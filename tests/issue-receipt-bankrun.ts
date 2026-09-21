import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { Clock, ProgramTestContext } from "solana-bankrun";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { assert, AssertionError } from "chai";

describe("fundraiser - issue receipt", () => {
  const TARGET = 10_000_000;
  const CONTRIBUTION = 1_000_000;
  const CONTRIBUTOR_COUNT = 10;
  const DURATION_DAYS = 7;
  const DAY = 86_400n;
  const SLOTS_PER_DAY = 216_000n;

  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Fundraiser>;
  let payer: anchor.web3.Keypair;

  type Campaign = {
    maker: anchor.web3.Keypair;
    contributors: anchor.web3.Keypair[];
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
    contributorAtas: anchor.web3.PublicKey[];
  };

  before(async () => {
    console.log("\n[setup] Starting an in-process Solana bankrun test");
    context = await startAnchor("", [], []);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    program = new anchor.Program<Fundraiser>(
      require("../target/idl/fundraiser.json"),
      provider
    );
    payer = context.payer;
  });

  const send = async (
    instructions: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Keypair[] = []
  ) => {
    const tx = new anchor.web3.Transaction();
    const clock = await context.banksClient.getClock();
    context.warpToSlot(clock.slot + 1n);
    const [blockhash] = await context.banksClient.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(...instructions);
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

  const tokenAccountAmount = async (
    address: anchor.web3.PublicKey,
    tokenProgram = TOKEN_PROGRAM_ID
  ): Promise<bigint> => {
    const account = await context.banksClient.getAccount(address);
    assert.isNotNull(account, `token account ${address.toBase58()} should exist`);
    return unpackAccount(address, {
      ...account!,
      data: Buffer.from(account!.data),
      owner: new anchor.web3.PublicKey(account!.owner),
    } as any, tokenProgram).amount;
  };

  const mintState = async (
    address: anchor.web3.PublicKey,
    tokenProgram = TOKEN_PROGRAM_ID
  ) => {
    const account = await context.banksClient.getAccount(address);
    assert.isNotNull(account, `mint ${address.toBase58()} should exist`);
    return unpackMint(address, {
      ...account!,
      data: Buffer.from(account!.data),
      owner: new anchor.web3.PublicKey(account!.owner),
    } as any, tokenProgram);
  };

  const errorCodeOf = (error: any): string => {
    if (error instanceof AssertionError) throw error;
    if (error?.error?.errorCode?.code) return error.error.errorCode.code;
    const text = `${error?.message ?? ""} ${JSON.stringify(error?.logs ?? [])}`;
    const name = text.match(/Error Code: (\w+)/);
    if (name) return name[1];
    const number = text.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (number) {
      const code = parseInt(number[1], 16);
      const known = (program.idl.errors ?? []).find((item: any) => item.code === code);
      if (known) return known.name;
    }
    return text.slice(0, 300);
  };

  const assertErrorIs = (error: any, expected: string, reason: string) => {
    assert.strictEqual(
      errorCodeOf(error).toLowerCase(),
      expected.toLowerCase(),
      `${reason} (expected ${expected})`
    );
  };

  const contributorAccount = (
    campaign: Campaign,
    contributor: anchor.web3.Keypair
  ) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), campaign.fundraiser.toBuffer(), contributor.publicKey.toBuffer()],
      program.programId
    )[0];

  const receiptMint = (
    campaign: Campaign,
    contributor: anchor.web3.Keypair
  ) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt-mint"), campaign.fundraiser.toBuffer(), contributor.publicKey.toBuffer()],
      program.programId
    )[0];

  const createCampaign = async (): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    const contributors = [
      payer,
      ...Array.from({ length: CONTRIBUTOR_COUNT - 1 }, () => anchor.web3.Keypair.generate()),
    ];
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;
    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    const makerAta = getAssociatedTokenAddressSync(mint, maker.publicKey, false);
    const contributorAtas = contributors.map((contributor) =>
      getAssociatedTokenAddressSync(mint, contributor.publicKey, false)
    );

    console.log("    creating campaign wallets and contribution mint");
    const rent = await context.banksClient.getRent();
    await send(
      [
        anchor.web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: maker.publicKey, lamports: anchor.web3.LAMPORTS_PER_SOL }),
        ...contributors.slice(1).map((contributor) =>
          anchor.web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: contributor.publicKey, lamports: anchor.web3.LAMPORTS_PER_SOL })
        ),
        anchor.web3.SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: MINT_SIZE, lamports: Number(rent.minimumBalance(BigInt(MINT_SIZE))), programId: TOKEN_PROGRAM_ID }),
        createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
      ],
      [mintKeypair]
    );

    for (let index = 0; index < contributors.length; index += 1) {
      await send([
        createAssociatedTokenAccountInstruction(payer.publicKey, contributorAtas[index], contributors[index].publicKey, mint),
        createMintToInstruction(mint, contributorAtas[index], payer.publicKey, CONTRIBUTION),
      ]);
    }
    await send([createAssociatedTokenAccountInstruction(payer.publicKey, makerAta, maker.publicKey, mint)]);

    console.log("    initializing the seven-day fundraiser");
    await send(
      [
        await program.methods.initialize(new anchor.BN(TARGET), DURATION_DAYS).accountsPartial({
          maker: maker.publicKey,
          mintToRaise: mint,
          fundraiser,
          vault,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        }).instruction(),
      ],
      [maker]
    );

    return { maker, contributors, mint, fundraiser, vault, contributorAtas };
  };

  const contribute = async (campaign: Campaign, index: number, amount = CONTRIBUTION) => {
    const contributor = campaign.contributors[index];
    await send(
      [
        await program.methods.contribute(new anchor.BN(amount)).accountsPartial({
          contributor: contributor.publicKey,
          mintToRaise: campaign.mint,
          fundraiser: campaign.fundraiser,
          contributorAccount: contributorAccount(campaign, contributor),
          contributorAta: campaign.contributorAtas[index],
          vault: campaign.vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        }).instruction(),
      ],
      contributor === payer ? [] : [contributor]
    );
  };

  const issueReceipt = async (campaign: Campaign, contributor: anchor.web3.Keypair) => {
    const mint = receiptMint(campaign, contributor);
    const ata = getAssociatedTokenAddressSync(
      mint,
      contributor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await send(
      [
        await program.methods.issueReceipt().accountsPartial({
          contributor: contributor.publicKey,
          fundraiser: campaign.fundraiser,
          contributorAccount: contributorAccount(campaign, contributor),
          receiptMint: mint,
          contributorReceiptAta: ata,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        }).instruction(),
      ],
      contributor === payer ? [] : [contributor]
    );
    return { mint, ata };
  };

  const successfulCampaign = async () => {
    const campaign = await createCampaign();
    for (let index = 0; index < CONTRIBUTOR_COUNT; index += 1) await contribute(campaign, index);
    await advanceDays(BigInt(DURATION_DAYS + 1));
    return campaign;
  };

  it("happy path: mints one receipt and updates on-chain state", async () => {
    console.log("\n[happy path] Creating a successful campaign");
    const campaign = await successfulCampaign();
    const claimant = campaign.contributors[0];
    console.log("[happy path] Claiming the receipt");
    const { mint, ata } = await issueReceipt(campaign, claimant);
    const state = await program.account.contributor.fetch(contributorAccount(campaign, claimant));
    const receipt = await mintState(mint, TOKEN_2022_PROGRAM_ID);
    assert.isTrue(state.receiptClaimed, "receipt_claimed should be true");
    assert.strictEqual(receipt.supply, 1n, "receipt supply should be one");
    assert.strictEqual(await tokenAccountAmount(ata, TOKEN_2022_PROGRAM_ID), 1n, "claimant should own one receipt");
    console.log("[happy path] Verified supply=1, balance=1, receipt_claimed=true");
  });

  it("boundary: one contributor short fails, exact target succeeds", async () => {
    console.log("\n[boundary] Creating a campaign below the target");
    const campaign = await createCampaign();
    for (let index = 0; index < CONTRIBUTOR_COUNT - 1; index += 1) await contribute(campaign, index);
    const belowTarget = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(belowTarget.currentAmount.toString(), "9000000");
    console.log("[boundary] Current amount is 9,000,000; target is 10,000,000");
    await advanceDays(BigInt(DURATION_DAYS + 1));
    try {
      await issueReceipt(campaign, campaign.contributors[0]);
      assert.fail("expected a receipt claim below the target to be rejected");
    } catch (error) {
      assertErrorIs(error, "TargetNotMet", "below-target claim should fail for the target check");
      console.log("[boundary] Below-target claim rejected with TargetNotMet");
    }

    console.log("[boundary] Creating a fresh campaign and reaching exactly 10,000,000");
    const exactCampaign = await successfulCampaign();
    const exact = await program.account.fundraiser.fetch(exactCampaign.fundraiser);
    assert.strictEqual(exact.currentAmount.toString(), "10000000");
    const { ata } = await issueReceipt(exactCampaign, exactCampaign.contributors[0]);
    assert.strictEqual(await tokenAccountAmount(ata, TOKEN_2022_PROGRAM_ID), 1n, "exact target should mint the receipt");
    console.log("[boundary] Exact-target claim succeeded and minted one receipt");
  });

  it("abuse case: a second claim fails with ReceiptAlreadyClaimed", async () => {
    console.log("\n[abuse case] Creating a successful campaign and claiming once");
    const campaign = await successfulCampaign();
    const claimant = campaign.contributors[0];
    await issueReceipt(campaign, claimant);
    console.log("[abuse case] First claim succeeded; attempting the same claim again");
    try {
      await issueReceipt(campaign, claimant);
      assert.fail("expected the second claim to be rejected");
    } catch (error) {
      assertErrorIs(error, "ReceiptAlreadyClaimed", "duplicate claim should fail with the program error");
      console.log("[abuse case] Second claim rejected with ReceiptAlreadyClaimed");
    }
  });
});
