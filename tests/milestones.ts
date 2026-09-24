import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { assert, AssertionError } from "chai";

/**
 * Milestone feature tests:
 * Milestones at 25%, 50%, and 75% of the target amount.
 * Each milestone fires once (a bit in `milestones_fired` and a `MilestoneReached` event),
 * even when a contribution crosses a mark without landing on it.
 */
describe("fundraiser — milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  // 20 tokens target with 6 decimals.
  // 10% per-contributor cap is 2_000_000.
  // Minimum contribution is 1 whole token (1_000_000).
  const TARGET = 20_000_000;
  const CAP_PER_WALLET = 2_000_000;
  const MIN_CONTRIBUTION = 1_000_000;

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  const errorCodeOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;
    const text = `${err?.message ?? ""} ${JSON.stringify(err?.logs ?? [])}`;
    const match = text.match(/Error Code: (\w+)/);
    return match ? match[1] : text.slice(0, 300);
  };

  const assertErrorIs = (err: any, expected: string, why: string) => {
    const actual = errorCodeOf(err);
    assert.strictEqual(
      actual.toLowerCase(),
      expected.toLowerCase(),
      `${why} (expected ${expected}, got ${actual})`,
    );
  };

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  type ContributorInfo = {
    keypair: anchor.web3.Keypair;
    account: anchor.web3.PublicKey;
    ata: anchor.web3.PublicKey;
  };

  const openCampaign = async (durationDays = 7): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6,
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId,
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new anchor.BN(TARGET), durationDays)
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc()
      .then(confirm);

    return { maker, mint, fundraiser, vault };
  };

  const setupContributor = async (
    campaign: Campaign,
    tokens = 10 * CAP_PER_WALLET,
  ): Promise<ContributorInfo> => {
    const keypair = anchor.web3.Keypair.generate();

    const ata = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        campaign.mint,
        keypair.publicKey,
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      campaign.mint,
      ata,
      provider.publicKey,
      tokens,
    );

    const [account] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        campaign.fundraiser.toBuffer(),
        keypair.publicKey.toBuffer(),
      ],
      program.programId,
    );

    return { keypair, account, ata };
  };

  const contributeAs = (
    c: Campaign,
    contributor: ContributorInfo,
    amount: number,
  ) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.keypair.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: contributor.account,
        contributorAta: contributor.ata,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor.keypair])
      .rpc();

  // 1. Happy path
  it("happy path — crosses 25% milestone and sets bit 0 in milestones_fired", async () => {
    const campaign = await openCampaign();

    // 3 contributors contribute 2M each = 6M total (30% of target).
    // This crosses the 25% threshold (5M) without landing directly on it.
    const c1 = await setupContributor(campaign);
    const c2 = await setupContributor(campaign);
    const c3 = await setupContributor(campaign);

    await contributeAs(campaign, c1, CAP_PER_WALLET);
    await contributeAs(campaign, c2, CAP_PER_WALLET);
    await contributeAs(campaign, c3, CAP_PER_WALLET);

    const fundraiser = await program.account.fundraiser.fetch(
      campaign.fundraiser,
    );
    assert.strictEqual(
      fundraiser.milestonesFired & 1,
      1,
      "bit 0 should be set once progress crosses 25%",
    );
    assert.strictEqual(
      fundraiser.milestonesFired,
      1,
      "only the 25% milestone should fire at 30% progress",
    );
  });

  // 2. Exact 25% boundary
  it("exact 25% boundary — fires milestone 1 when landed on exactly", async () => {
    const campaign = await openCampaign();

    // 25% of 20M is exactly 5M: 2M + 2M + 1M
    const c1 = await setupContributor(campaign);
    const c2 = await setupContributor(campaign);
    const c3 = await setupContributor(campaign);

    await contributeAs(campaign, c1, CAP_PER_WALLET);
    await contributeAs(campaign, c2, CAP_PER_WALLET);
    await contributeAs(campaign, c3, MIN_CONTRIBUTION);

    const fundraiser = await program.account.fundraiser.fetch(
      campaign.fundraiser,
    );
    assert.strictEqual(
      fundraiser.currentAmount.toString(),
      "5000000",
      "current_amount should be exactly 5,000,000 (25%)",
    );
    assert.strictEqual(
      fundraiser.milestonesFired,
      1,
      "exact 25% mark must fire milestone 1",
    );
  });

  // 3. Capped whale
  it("capped whale — 10% per-wallet limit prevents a single whale from triggering 25% milestone", async () => {
    const campaign = await openCampaign();

    const whale = await setupContributor(campaign);
    // Whale contributes maximum allowed 10%
    await contributeAs(campaign, whale, CAP_PER_WALLET);

    // Whale attempts to contribute more, which is refused by per-wallet cap
    try {
      await contributeAs(campaign, whale, MIN_CONTRIBUTION);
      assert.fail("whale exceeding 10% per-contributor cap must be rejected");
    } catch (err) {
      assertErrorIs(
        err,
        "MaximumContributionsReached",
        "must enforce maximum contributions per contributor",
      );
    }

    const fundraiser = await program.account.fundraiser.fetch(
      campaign.fundraiser,
    );
    assert.strictEqual(
      fundraiser.milestonesFired,
      0,
      "no milestones should have fired at 10% progress",
    );
  });

  // 4. Idempotency
  it("idempotency — subsequent contributions in the same tier leave milestone flags unchanged", async () => {
    const campaign = await openCampaign();

    // Reach 25% (5M)
    const c1 = await setupContributor(campaign);
    const c2 = await setupContributor(campaign);
    const c3 = await setupContributor(campaign);
    await contributeAs(campaign, c1, CAP_PER_WALLET);
    await contributeAs(campaign, c2, CAP_PER_WALLET);
    await contributeAs(campaign, c3, MIN_CONTRIBUTION);

    const before = await program.account.fundraiser.fetch(campaign.fundraiser);
    const beforeMilestones = before.milestonesFired;

    // A 4th contributor adds 1M, moving total to 6M (30%), staying in the [25%, 50%) tier
    const c4 = await setupContributor(campaign);
    await contributeAs(campaign, c4, MIN_CONTRIBUTION);

    const after = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(
      after.milestonesFired,
      beforeMilestones,
      "milestones_fired must remain identical for contributions in the same tier",
    );
    assert.strictEqual(
      after.milestonesFired & 2,
      0,
      "50% milestone (bit 1) must not fire before reaching 50%",
    );
  });

  // 5. 75% cap
  it("75% cap — reaching 100% of the target does not fire past 75% (only bits 0, 1, 2 set)", async () => {
    const campaign = await openCampaign();

    // 10 contributors contribute 2M each = 20M (100% of target)
    for (let i = 0; i < 10; i++) {
      const c = await setupContributor(campaign);
      await contributeAs(campaign, c, CAP_PER_WALLET);
    }

    const fundraiser = await program.account.fundraiser.fetch(
      campaign.fundraiser,
    );
    assert.strictEqual(
      fundraiser.currentAmount.toString(),
      TARGET.toString(),
      "campaign should be fully funded",
    );
    // Bits 0 (25%), 1 (50%), 2 (75%) -> 1 | 2 | 4 = 7
    assert.strictEqual(
      fundraiser.milestonesFired,
      7,
      "milestones_fired should be 0b00000111 (7) for 25%, 50%, and 75%",
    );
    assert.strictEqual(
      fundraiser.milestonesFired & 8,
      0,
      "no milestone bit for 100% (bit 3) should exist or fire",
    );
  });

  // 6. Crossing multiple milestones without landing on intermediate ones
  it("crosses multiple marks — fires intermediate milestones when progressing across thresholds", async () => {
    const campaign = await openCampaign();

    // 5 contributors contribute 2M each = 10M (50% of target)
    for (let i = 0; i < 5; i++) {
      const c = await setupContributor(campaign);
      await contributeAs(campaign, c, CAP_PER_WALLET);
    }

    const fundraiser = await program.account.fundraiser.fetch(
      campaign.fundraiser,
    );
    assert.strictEqual(
      fundraiser.currentAmount.toString(),
      "10000000",
      "current_amount should reach 10M (50%)",
    );
    // Both 25% (bit 0) and 50% (bit 1) must be fired -> 1 | 2 = 3
    assert.strictEqual(
      fundraiser.milestonesFired,
      3,
      "milestones_fired should have bits 0 and 1 set (3) at 50% progress",
    );
  });
});
