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

describe("fundraiser — failed campaign lifecycle cleanup", () => {
  const TARGET = 30_000_000;
  const CONTRIBUTION = 1_000_000;
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

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    contributorAccount: anchor.web3.PublicKey;
    contributorAta: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  const send = async (
    ixs: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Keypair[] = [],
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
        before.unixTimestamp + days * DAY,
      ),
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
      const known = (program.idl.errors ?? []).find(
        (e: any) => e.code === code,
      );
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
      `${why} (expected ${expected}, got ${actual})`,
    );
  };

  const tokenBalance = async (
    address: anchor.web3.PublicKey,
  ): Promise<bigint> => {
    const account = await context.banksClient.getAccount(address);
    assert.isNotNull(account, "token account should exist");
    return unpackAccount(address, {
      ...account!,
      data: Buffer.from(account!.data),
      owner: new anchor.web3.PublicKey(account!.owner),
    } as any).amount;
  };

  const assertClosed = async (
    address: anchor.web3.PublicKey,
    label: string,
  ) => {
    const account = await context.banksClient.getAccount(address);
    assert.isNull(account, `${label} should be closed`);
  };

  const openCampaign = async (withContribution: boolean): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;

    const rent = await context.banksClient.getRent();
    const mintRent = Number(rent.minimumBalance(BigInt(MINT_SIZE)));
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
          lamports: mintRent,
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
      [maker],
    );

    const campaign = {
      maker,
      mint,
      fundraiser,
      contributorAccount,
      contributorAta,
      vault,
    };

    if (withContribution) {
      await send([await contributeIx(campaign)]);
    }

    return campaign;
  };

  const contributeIx = (c: Campaign) =>
    program.methods
      .contribute(new anchor.BN(CONTRIBUTION))
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

  const closeFailedFundraiserIx = (c: Campaign) =>
    program.methods
      .closeFailedFundraiser()
      .accountsPartial({
        maker: c.maker.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

  it("closes the failed fundraiser and empty vault after the final refund", async () => {
    const campaign = await openCampaign(true);

    await advanceDays(8n);
    await send([await refundIx(campaign)]);
    assert.strictEqual(
      await tokenBalance(campaign.contributorAta),
      BigInt(10 * CONTRIBUTION),
    );
    assert.strictEqual(await tokenBalance(campaign.vault), 0n);

    await send([await closeFailedFundraiserIx(campaign)], [campaign.maker]);

    await assertClosed(campaign.vault, "vault ATA");
    await assertClosed(campaign.fundraiser, "fundraiser PDA");
  });

  it("refuses cleanup after the deadline while refundable tokens remain", async () => {
    const campaign = await openCampaign(true);

    await advanceDays(8n);

    try {
      await send([await closeFailedFundraiserIx(campaign)], [campaign.maker]);
      assert.fail(
        "cleanup must wait until every refundable token has left the vault",
      );
    } catch (err) {
      assertErrorIs(
        err,
        "VaultNotEmpty",
        "cleanup should refuse a non-empty failed vault",
      );
    }

    assert.strictEqual(
      await tokenBalance(campaign.vault),
      BigInt(CONTRIBUTION),
    );
  });

  it("refuses cleanup before the fundraiser window closes", async () => {
    const campaign = await openCampaign(false);

    try {
      await send([await closeFailedFundraiserIx(campaign)], [campaign.maker]);
      assert.fail("cleanup must not close an active fundraiser");
    } catch (err) {
      assertErrorIs(
        err,
        "FundraiserNotEnded",
        "cleanup should wait for the fundraiser deadline",
      );
    }

    const fundraiserAccount = await context.banksClient.getAccount(
      campaign.fundraiser,
    );
    assert.isNotNull(fundraiserAccount, "active fundraiser should remain open");
  });
});
