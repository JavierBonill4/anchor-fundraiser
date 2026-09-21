import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
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
import { assert, AssertionError } from "chai";

const DAY = 86_400n;
const SLOTS_PER_DAY = 216_000n;
const DURATION_DAYS = 7;
const TOKEN_DECIMALS = 6;
const CONTRIBUTOR_TOKENS = 50_000_000;

type Campaign = {
  context: ProgramTestContext;
  program: Program<Fundraiser>;
  payer: anchor.web3.Keypair;
  maker: anchor.web3.Keypair;
  mint: anchor.web3.PublicKey;
  fundraiser: anchor.web3.PublicKey;
  vault: anchor.web3.PublicKey;
};

type Contributor = {
  keypair: anchor.web3.Keypair;
  ata: anchor.web3.PublicKey;
  account: anchor.web3.PublicKey;
};

describe("fundraiser — milestone tracking (bankrun)", () => {
  const send = async (
    campaign: Campaign,
    instructions: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Keypair[] = [],
  ) => {
    const transaction = new anchor.web3.Transaction();
    const [blockhash] = await campaign.context.banksClient.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = campaign.payer.publicKey;
    transaction.add(...instructions);
    transaction.sign(campaign.payer, ...signers);
    return campaign.context.banksClient.processTransaction(transaction);
  };

  const startCampaign = async (target: number): Promise<Campaign> => {
    const context = await startAnchor("", [], []);
    const provider = new BankrunProvider(context);
    anchor.setProvider(provider);

    const idl = require("../target/idl/fundraiser.json");
    const program = new anchor.Program<Fundraiser>(idl, provider);
    const payer = context.payer;
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;
    const rent = await context.banksClient.getRent();
    const mintRent = Number(rent.minimumBalance(BigInt(MINT_SIZE)));

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId,
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    const campaign = {
      context,
      program,
      payer,
      maker,
      mint,
      fundraiser,
      vault,
    };

    await send(
      campaign,
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
        createInitializeMint2Instruction(
          mint,
          TOKEN_DECIMALS,
          payer.publicKey,
          null,
        ),
      ],
      [mintKeypair],
    );

    await send(
      campaign,
      [
        await program.methods
          .initialize(new anchor.BN(target), DURATION_DAYS)
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

    return campaign;
  };

  const createContributor = async (
    campaign: Campaign,
  ): Promise<Contributor> => {
    const keypair = anchor.web3.Keypair.generate();
    const ata = getAssociatedTokenAddressSync(campaign.mint, keypair.publicKey);
    const [account] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        campaign.fundraiser.toBuffer(),
        keypair.publicKey.toBuffer(),
      ],
      campaign.program.programId,
    );

    await send(campaign, [
      anchor.web3.SystemProgram.transfer({
        fromPubkey: campaign.payer.publicKey,
        toPubkey: keypair.publicKey,
        lamports: anchor.web3.LAMPORTS_PER_SOL,
      }),
      createAssociatedTokenAccountInstruction(
        campaign.payer.publicKey,
        ata,
        keypair.publicKey,
        campaign.mint,
      ),
      createMintToInstruction(
        campaign.mint,
        ata,
        campaign.payer.publicKey,
        CONTRIBUTOR_TOKENS,
      ),
    ]);

    return { keypair, ata, account };
  };

  const contribute = async (
    campaign: Campaign,
    contributor: Contributor,
    amount: number,
  ) => {
    await send(
      campaign,
      [
        await campaign.program.methods
          .contribute(new anchor.BN(amount))
          .accountsPartial({
            contributor: contributor.keypair.publicKey,
            mintToRaise: campaign.mint,
            fundraiser: campaign.fundraiser,
            contributorAccount: contributor.account,
            contributorAta: contributor.ata,
            vault: campaign.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
      ],
      [contributor.keypair],
    );
  };

  const fundraiserState = (campaign: Campaign) =>
    campaign.program.account.fundraiser.fetch(campaign.fundraiser);

  const advanceDays = async (campaign: Campaign, days: bigint) => {
    const before = await campaign.context.banksClient.getClock();
    campaign.context.warpToSlot(before.slot + days * SLOTS_PER_DAY);
    const clock = await campaign.context.banksClient.getClock();
    campaign.context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        before.unixTimestamp + days * DAY,
      ),
    );
  };

  const errorCodeOf = (campaign: Campaign, err: any): string => {
    if (err instanceof AssertionError) throw err;
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;

    const text = `${err?.message ?? ""} ${JSON.stringify(err?.logs ?? [])}`;
    const byName = text.match(/Error Code: (\w+)/);
    if (byName) return byName[1];

    const byNumber = text.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (byNumber) {
      const code = parseInt(byNumber[1], 16);
      const known = (campaign.program.idl.errors ?? []).find(
        (error: any) => error.code === code,
      );
      if (known) return known.name;
    }

    return text.slice(0, 300);
  };

  it("progresses the persistent mask through 25%, 50%, and 75%", async () => {
    const campaign = await startCampaign(40_000_000);
    const contributions = [
      4_000_000, 4_000_000, 2_000_000, 4_000_000, 4_000_000, 2_000_000,
      4_000_000, 4_000_000, 2_000_000,
    ];

    for (let index = 0; index < contributions.length; index += 1) {
      const contributor = await createContributor(campaign);
      await contribute(campaign, contributor, contributions[index]);

      const contributorState = await campaign.program.account.contributor.fetch(
        contributor.account,
      );
      assert.strictEqual(
        contributorState.amount.toNumber(),
        contributions[index],
      );

      if (index === 2 || index === 5 || index === 8) {
        const milestoneNumber = Math.floor(index / 3) + 1;
        const expectedTotal = milestoneNumber * 10_000_000;
        const state = await fundraiserState(campaign);
        assert.strictEqual(state.currentAmount.toNumber(), expectedTotal);
        assert.strictEqual(state.milestonesReached, (1 << milestoneNumber) - 1);
      }
    }
  });

  it("rounds the 25% threshold up without firing one unit early", async () => {
    for (const [lastAmount, expectedMask] of [[2_000_001, 0], [2_000_002, 0b001]]) {
      const campaign = await startCampaign(40_000_007);
      const amounts = [4_000_000, 4_000_000, lastAmount];

      for (const amount of amounts) {
        await contribute(campaign, await createContributor(campaign), amount);
      }

      const state = await fundraiserState(campaign);
      assert.strictEqual(state.currentAmount.toNumber(), 8_000_000 + lastAmount);
      assert.strictEqual(state.milestonesReached, expectedMask);
    }
  });

  it("keeps reached milestones after a refund lowers current amount", async () => {
    const campaign = await startCampaign(40_000_000);
    const contributors: Contributor[] = [];

    for (let index = 0; index < 3; index += 1) {
      const contributor = await createContributor(campaign);
      contributors.push(contributor);
      await contribute(campaign, contributor, 4_000_000);
    }

    const beforeRefund = await fundraiserState(campaign);
    assert.strictEqual(beforeRefund.currentAmount.toNumber(), 12_000_000);
    assert.strictEqual(beforeRefund.milestonesReached, 0b001);

    await advanceDays(campaign, 8n);
    const refunded = contributors[0];
    await send(
      campaign,
      [
        await campaign.program.methods
          .refund()
          .accountsPartial({
            contributor: refunded.keypair.publicKey,
            maker: campaign.maker.publicKey,
            mintToRaise: campaign.mint,
            fundraiser: campaign.fundraiser,
            contributorAccount: refunded.account,
            contributorAta: refunded.ata,
            vault: campaign.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
      ],
      [refunded.keypair],
    );

    const afterRefund = await fundraiserState(campaign);
    assert.strictEqual(afterRefund.currentAmount.toNumber(), 8_000_000);
    assert.strictEqual(afterRefund.milestonesReached, 0b001);
  });

  it("rejects an over-cap contribution without changing milestone state", async () => {
    const campaign = await startCampaign(40_000_000);
    const contributor = await createContributor(campaign);

    try {
      await contribute(campaign, contributor, 4_000_001);
      assert.fail("a contribution above 10% should have been rejected");
    } catch (err) {
      assert.strictEqual(errorCodeOf(campaign, err), "contributionTooBig");
    }

    const state = await fundraiserState(campaign);
    assert.strictEqual(state.currentAmount.toNumber(), 0);
    assert.strictEqual(state.milestonesReached, 0);
    assert.isNull(
      await campaign.context.banksClient.getAccount(contributor.account),
    );
  });
});
