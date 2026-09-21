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

describe("fundraiser — milestone unlocks", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  // Target: 40 tokens (with 6 decimals = 40_000_000)
  // 10% max per contributor = 4_000_000 (4 tokens)
  // 25% milestone = 10_000_000
  // 50% milestone = 20_000_000
  // 75% milestone = 30_000_000
  const TARGET = 40_000_000;
  const MAX_CONTRIBUTION = 4_000_000;

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

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  const openCampaign = async (targetAmount: number = TARGET, durationDays: number = 7): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new anchor.BN(targetAmount), durationDays)
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

  const createContributor = async (
    c: Campaign,
    mintAmount: number = 10_000_000
  ): Promise<{
    keypair: anchor.web3.Keypair;
    account: anchor.web3.PublicKey;
    ata: anchor.web3.PublicKey;
  }> => {
    const keypair = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(keypair.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const ata = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        c.mint,
        keypair.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      c.mint,
      ata,
      provider.publicKey,
      mintAmount
    );

    const [account] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), c.fundraiser.toBuffer(), keypair.publicKey.toBuffer()],
      program.programId
    );

    return { keypair, account, ata };
  };

  const contributeAs = (
    c: Campaign,
    user: { keypair: anchor.web3.Keypair; account: anchor.web3.PublicKey; ata: anchor.web3.PublicKey },
    amount: number
  ) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: user.keypair.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: user.account,
        contributorAta: user.ata,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([user.keypair])
      .rpc();

  // ------------------------------------------------------------------
  // 1. Happy Path: Milestones fire sequentially at 25%, 50%, 75%
  // ------------------------------------------------------------------
  it("happy path: fires milestones progressively at 25%, 50%, and 75%", async () => {
    const campaign = await openCampaign(TARGET, 7);

    // Initial state: milestones_fired is 0
    let fState = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fState.milestonesFired, 0, "initial milestones_fired must be 0");

    // Add contributors to reach 20% (8M total): no milestone yet
    const u1 = await createContributor(campaign);
    const u2 = await createContributor(campaign);
    await contributeAs(campaign, u1, MAX_CONTRIBUTION); // 4M
    await contributeAs(campaign, u2, MAX_CONTRIBUTION); // 8M (20%)

    fState = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fState.milestonesFired, 0, "at 20% no milestone should fire");

    // u3 contributes 2M -> total 10M = 25%
    const u3 = await createContributor(campaign);
    await contributeAs(campaign, u3, 2_000_000); // 10M total (25%)

    fState = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fState.milestonesFired, 1, "at 25% milestone bit 0 must be set (1)");

    // u3 contributes another 2M -> total 12M (30%): bit 0 remains set, bit 1 not set
    await contributeAs(campaign, u3, 2_000_000); // 12M total (30%)
    fState = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fState.milestonesFired, 1, "at 30% milestone bit 0 remains 1");

    // u4 contributes 4M, u5 contributes 4M -> total 20M = 50%
    const u4 = await createContributor(campaign);
    const u5 = await createContributor(campaign);
    await contributeAs(campaign, u4, MAX_CONTRIBUTION);
    await contributeAs(campaign, u5, MAX_CONTRIBUTION); // 20M total (50%)

    fState = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fState.milestonesFired, 3, "at 50% milestone bits 0 and 1 must be set (3)");

    // u6, u7 contribute 4M each, u8 contributes 2M -> total 30M = 75%
    const u6 = await createContributor(campaign);
    const u7 = await createContributor(campaign);
    const u8 = await createContributor(campaign);
    await contributeAs(campaign, u6, MAX_CONTRIBUTION);
    await contributeAs(campaign, u7, MAX_CONTRIBUTION);
    await contributeAs(campaign, u8, 2_000_000); // 30M total (75%)

    fState = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fState.milestonesFired, 7, "at 75% milestone bits 0, 1, 2 must be set (7)");
  });

  // ------------------------------------------------------------------
  // 2. Boundary Test: exactly 1 raw unit below 25% vs crossing 25%
  // ------------------------------------------------------------------
  it("boundary test: does not fire at 1 unit below 25% (24.99999%) and fires on reaching 25%", async () => {
    const campaign = await openCampaign(TARGET, 7);

    const u1 = await createContributor(campaign);
    const u2 = await createContributor(campaign);
    const u3 = await createContributor(campaign);

    // 4M + 4M + 1_999_999 = 9_999_999 (one unit below the 10_000_000 25% threshold)
    await contributeAs(campaign, u1, 4_000_000);
    await contributeAs(campaign, u2, 4_000_000);
    await contributeAs(campaign, u3, 1_999_999);

    let fState = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(
      fState.currentAmount.toString(),
      "9999999",
      "vault should hold exactly 9,999,999"
    );
    assert.strictEqual(
      fState.milestonesFired,
      0,
      "at 9,999,999 (1 unit below 25%), milestones_fired must be 0"
    );

    // Contributor 4 contributes 1_000_001, crossing the 25% threshold (total 11_000_000)
    const u4 = await createContributor(campaign);
    await contributeAs(campaign, u4, 1_000_001);

    fState = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(
      fState.currentAmount.toString(),
      "11000000",
      "vault should hold 11,000,000"
    );
    assert.strictEqual(
      fState.milestonesFired,
      1,
      "after crossing 25%, milestone bit 0 must be 1"
    );
  });

  // ------------------------------------------------------------------
  // 3. Abuse / Edge Case: Multi-milestone jump & repeat idempotency
  // ------------------------------------------------------------------
  it("abuse and idempotency: leap-frogging milestones and preventing duplicate flags", async () => {
    // Campaign with TARGET 10 tokens = 10_000_000 (10% cap = 1_000_000)
    // 25% = 2_500_000, 50% = 5_000_000
    const campaign = await openCampaign(10_000_000, 7);

    // u1 and u2 contribute 1M each -> 2M total (20% -> 0 milestones)
    const u1 = await createContributor(campaign);
    const u2 = await createContributor(campaign);
    await contributeAs(campaign, u1, 1_000_000);
    await contributeAs(campaign, u2, 1_000_000);

    let fState = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fState.milestonesFired, 0, "at 2M (20%) no milestone fired");

    // Add contributors in sequence:
    // u3 contributes 1M -> total 3M (30%) -> crosses 25% milestone (bit 0 = 1)
    const u3 = await createContributor(campaign);
    await contributeAs(campaign, u3, 1_000_000);

    fState = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fState.milestonesFired, 1, "at 3M bit 0 is set");

    // u4 contributes 1M -> total 4M (40%) -> still between 25% and 50% -> bit 0 stays 1
    const u4 = await createContributor(campaign);
    await contributeAs(campaign, u4, 1_000_000);

    fState = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(
      fState.milestonesFired,
      1,
      "repeat contribution within the same bracket must be idempotent"
    );

    // Contributor attempts to exceed their 10% cap (abuse attempt)
    try {
      await contributeAs(campaign, u4, 1_000_000);
      assert.fail("expected exceeding individual cap to fail");
    } catch (err) {
      const code = errorCodeOf(err);
      assert.strictEqual(
        code.toLowerCase(),
        "maximumcontributionsreached",
        `expected MaximumContributionsReached error, got ${code}`
      );
    }

    // Milestones state must remain unchanged after rejected transaction
    fState = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fState.milestonesFired, 1, "milestones_fired unchanged after failed abuse attempt");
  });
});
