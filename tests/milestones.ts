import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

describe("fundraiser — milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const payer = provider.wallet.payer;

  const TARGET = 30_000_000;
  const MAX_CONTRIBUTION = 3_000_000;

  async function createCampaign() {
    const maker = Keypair.generate();

    const makerBalance = await provider.connection.getBalance(maker.publicKey);

    if (makerBalance < 1_000_000_000) {
      const signature = await provider.connection.requestAirdrop(
        maker.publicKey,
        1_000_000_000
      );

      await provider.connection.confirmTransaction(signature);
    }

    const mint = await createMint(
      provider.connection,
      payer,
      payer.publicKey,
      null,
      6
    );

    const fundraiser = PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    )[0];

    const vault = anchor.utils.token.associatedAddress({
        mint,
        owner: fundraiser,
      });
      
      await program.methods
        .initialize(new anchor.BN(TARGET), 7)
        .accounts({
          maker: maker.publicKey,
          mintToRaise: mint,
          fundraiser,
          vault,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          associatedTokenProgram:
            anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([maker])
        .rpc();

    return {
      maker,
      mint,
      fundraiser,
      vault: vault.address,
    };
  }

  async function createContributor(mint: PublicKey) {
    const contributor = Keypair.generate();

    const signature = await provider.connection.requestAirdrop(
      contributor.publicKey,
      1_000_000_000
    );

    await provider.connection.confirmTransaction(signature);

    const contributorAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      contributor.publicKey
    );

    await mintTo(
      provider.connection,
      payer,
      mint,
      contributorAta.address,
      payer,
      MAX_CONTRIBUTION
    );

    return {
      contributor,
      contributorAta: contributorAta.address,
    };
  }

  async function contribute(
    campaign: {
      fundraiser: PublicKey;
      mint: PublicKey;
      vault: PublicKey;
    },
    contributor: {
      contributor: Keypair;
      contributorAta: PublicKey;
    },
    amount: number
  ) {
    const contributorAccount = PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        campaign.fundraiser.toBuffer(),
        contributor.contributor.publicKey.toBuffer(),
      ],
      program.programId
    )[0];

    await program.methods
      .contribute(new anchor.BN(amount))
      .accounts({
        contributor: contributor.contributor.publicKey,
        mintToRaise: campaign.mint,
        fundraiser: campaign.fundraiser,
        contributorAccount,
        contributorAta: contributor.contributorAta,
        vault: campaign.vault,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([contributor.contributor])
      .rpc();
  }

  async function getMilestoneState(fundraiser: PublicKey) {
    const account = await program.account.fundraiser.fetch(fundraiser);

    return {
      currentAmount: account.currentAmount.toNumber(),
      milestonesFired: account.milestonesFired,
    };
  }

  it("records the 25% milestone when the threshold is reached", async () => {
    const campaign = await createCampaign();

    const contributors = await Promise.all(
      Array.from({ length: 3 }, () => createContributor(campaign.mint))
    );

    await contribute(campaign, contributors[0], 3_000_000);
    await contribute(campaign, contributors[1], 3_000_000);
    await contribute(campaign, contributors[2], 1_500_000);

    const state = await getMilestoneState(campaign.fundraiser);

    assert.strictEqual(state.currentAmount, 7_500_000);
    assert.strictEqual(state.milestonesFired, 1);
  });

  it("does not fire below 25%, but fires when the threshold is crossed", async () => {
    const campaign = await createCampaign();
  
    const contributors = await Promise.all(
      Array.from({ length: 4 }, () => createContributor(campaign.mint))
    );
  
    // 3M + 3M = 6M, below the 25% threshold of 7.5M.
    await contribute(campaign, contributors[0], 3_000_000);
    await contribute(campaign, contributors[1], 3_000_000);
  
    let state = await getMilestoneState(campaign.fundraiser);
  
    assert.strictEqual(state.currentAmount, 6_000_000);
    assert.strictEqual(state.milestonesFired, 0);
  
    // 6M + 1M = 7M, still below 25%.
    await contribute(campaign, contributors[2], 1_000_000);
  
    state = await getMilestoneState(campaign.fundraiser);
  
    assert.strictEqual(state.currentAmount, 7_000_000);
    assert.strictEqual(state.milestonesFired, 0);
  
    // 7M + 1M = 8M, crossing the 25% threshold.
    await contribute(campaign, contributors[3], 1_000_000);
  
    state = await getMilestoneState(campaign.fundraiser);
  
    assert.strictEqual(state.currentAmount, 8_000_000);
    assert.strictEqual(state.milestonesFired, 1);
  });

  it("records the 50% milestone after crossing it", async () => {
    const campaign = await createCampaign();

    const contributors = await Promise.all(
      Array.from({ length: 5 }, () => createContributor(campaign.mint))
    );

    // 5 × 3M = 15M = 50%
    for (const contributor of contributors) {
      await contribute(campaign, contributor, 3_000_000);
    }

    const state = await getMilestoneState(campaign.fundraiser);

    assert.strictEqual(state.currentAmount, 15_000_000);

    // 0011 means 25% and 50% have fired.
    assert.strictEqual(state.milestonesFired, 3);
  });

  it("records the 75% milestone after crossing all thresholds", async () => {
    const campaign = await createCampaign();

    const contributors = await Promise.all(
      Array.from({ length: 8 }, () => createContributor(campaign.mint))
    );

    // 8 × 3M = 24M = 80%, crossing 25%, 50%, and 75%.
    for (const contributor of contributors) {
      await contribute(campaign, contributor, 3_000_000);
    }

    const state = await getMilestoneState(campaign.fundraiser);

    assert.strictEqual(state.currentAmount, 24_000_000);

    // 0111 means all three milestones have fired.
    assert.strictEqual(state.milestonesFired, 7);
  });

  it("does not fire the same milestone twice", async () => {
    const campaign = await createCampaign();

    const contributors = await Promise.all(
      Array.from({ length: 4 }, () => createContributor(campaign.mint))
    );

    // Reach 25%.
    await contribute(campaign, contributors[0], 3_000_000);
    await contribute(campaign, contributors[1], 3_000_000);
    await contribute(campaign, contributors[2], 1_500_000);

    let state = await getMilestoneState(campaign.fundraiser);

    assert.strictEqual(state.milestonesFired, 1);

    // Make another valid contribution after the milestone.
    await contribute(campaign, contributors[3], 1_000_000);

    state = await getMilestoneState(campaign.fundraiser);

    assert.strictEqual(state.currentAmount, 8_500_000);

    // The 25% bit is already set and must not be set again.
    assert.strictEqual(state.milestonesFired, 1);
  });
});