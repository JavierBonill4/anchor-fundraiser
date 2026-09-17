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
import { assert } from "chai";

describe("fundraiser — milestone unlocks", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  // 40 tokens target (40_000_000 raw units with 6 decimals).
  // 10% per-contributor cap is 4_000_000 (4 tokens), comfortably above the 1 token minimum.
  // Milestones:
  // 25% = 10_000_000
  // 50% = 20_000_000
  // 75% = 30_000_000
  const TARGET = 40_000_000;

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
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

  const openCampaign = async (durationDays: number = 7): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
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

  const createContributor = async (
    c: Campaign,
    tokensToMint: number = 10_000_000
  ): Promise<ContributorInfo> => {
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
      tokensToMint
    );

    const [account] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), c.fundraiser.toBuffer(), keypair.publicKey.toBuffer()],
      program.programId
    );

    return { keypair, account, ata };
  };

  const contribute = async (
    c: Campaign,
    contributor: ContributorInfo,
    amount: number
  ) => {
    return program.methods
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
      .rpc()
      .then(confirm);
  };

  it("Happy path: sequential contributions progressively unlock 25%, 50%, and 75% milestones", async () => {
    const c = await openCampaign(7);

    // Initial state: milestonesFired must be 0
    let account = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(account.milestonesFired, 0, "initial milestones_fired must be 0");

    // Track MilestoneReached events
    const firedEvents: any[] = [];
    const listenerId = program.addEventListener("milestoneReached", (event) => {
      firedEvents.push(event);
    });

    try {
      // Contributor 1 contributes 4_000_000 (10% of 40M) -> total 4M (10% < 25%)
      const contrib1 = await createContributor(c);
      await contribute(c, contrib1, 4_000_000);
      account = await program.account.fundraiser.fetch(c.fundraiser);
      assert.strictEqual(account.milestonesFired, 0, "milestones should not fire at 10%");

      // Contributor 2 contributes 4_000_000 -> total 8M (20% < 25%)
      const contrib2 = await createContributor(c);
      await contribute(c, contrib2, 4_000_000);
      account = await program.account.fundraiser.fetch(c.fundraiser);
      assert.strictEqual(account.milestonesFired, 0, "milestones should not fire at 20%");

      // Contributor 3 contributes 4_000_000 -> total 12M (30% >= 25%)
      // Bit 0 must be set (1 << 0 = 1)
      const contrib3 = await createContributor(c);
      await contribute(c, contrib3, 4_000_000);
      account = await program.account.fundraiser.fetch(c.fundraiser);
      assert.strictEqual(account.milestonesFired, 1, "bit 0 (25% milestone) should be fired");

      // Contributors 4 and 5 contribute 4_000_000 each -> total 20M (50% >= 50%)
      // Bit 0 and Bit 1 must be set (1 | 2 = 3)
      const contrib4 = await createContributor(c);
      await contribute(c, contrib4, 4_000_000);
      const contrib5 = await createContributor(c);
      await contribute(c, contrib5, 4_000_000);
      account = await program.account.fundraiser.fetch(c.fundraiser);
      assert.strictEqual(account.milestonesFired, 3, "bits 0 and 1 (25% and 50% milestones) should be fired");

      // Contributors 6, 7, 8 contribute 4M, 4M, 2M -> total 30M (75% >= 75%)
      // Bits 0, 1, and 2 must be set (1 | 2 | 4 = 7)
      const contrib6 = await createContributor(c);
      await contribute(c, contrib6, 4_000_000);
      const contrib7 = await createContributor(c);
      await contribute(c, contrib7, 4_000_000);
      const contrib8 = await createContributor(c);
      await contribute(c, contrib8, 2_000_000);
      account = await program.account.fundraiser.fetch(c.fundraiser);
      assert.strictEqual(account.milestonesFired, 7, "bits 0, 1, 2 (25%, 50%, 75% milestones) should be fired");

      // Wait briefly for asynchronous websocket events to deliver
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify events captured
      assert.isAtLeast(firedEvents.length, 3, "should emit at least 3 milestone events");
      assert.strictEqual(firedEvents[0].quarter, 1);
      assert.strictEqual(firedEvents[1].quarter, 2);
      assert.strictEqual(firedEvents[2].quarter, 3);
    } finally {
      await program.removeEventListener(listenerId);
    }
  });

  it("Boundary test: exactly 1 unit below 25% does not fire; crossing 25% fires bit 0", async () => {
    const c = await openCampaign(7);

    // Contributor 1 contributes 4_000_000 (total 4M)
    const contrib1 = await createContributor(c);
    await contribute(c, contrib1, 4_000_000);

    // Contributor 2 contributes 4_000_000 (total 8M)
    const contrib2 = await createContributor(c);
    await contribute(c, contrib2, 4_000_000);

    // Contributor 3 contributes 1_999_999 (total = 9_999_999, exactly 1 unit below 25% = 10_000_000)
    const contrib3 = await createContributor(c);
    await contribute(c, contrib3, 1_999_999);

    let account = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(
      account.currentAmount.toNumber(),
      9_999_999,
      "current amount should be 9,999,999"
    );
    assert.strictEqual(
      account.milestonesFired,
      0,
      "milestones_fired MUST be 0 when exactly 1 unit below 25%"
    );

    // Contributor 4 contributes 1_000_000 (minimum token amount). Total reaches 10_999_999 (> 10M)
    const contrib4 = await createContributor(c);
    await contribute(c, contrib4, 1_000_000);

    account = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(
      account.milestonesFired,
      1,
      "milestones_fired bit 0 MUST be set once 25% boundary is crossed"
    );
  });

  it("Idempotency: subsequent contributions within the same threshold do not re-fire flags", async () => {
    const c = await openCampaign(7);

    // Reach past 25% mark
    const contrib1 = await createContributor(c);
    await contribute(c, contrib1, 4_000_000);
    const contrib2 = await createContributor(c);
    await contribute(c, contrib2, 4_000_000);
    const contrib3 = await createContributor(c);
    await contribute(c, contrib3, 3_000_000); // total 11M (27.5% > 25%)

    let account = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(account.milestonesFired, 1, "bit 0 should be set");

    // Next contribution stays below 50% mark (e.g. +2M = 13M, 32.5% < 50%)
    const contrib4 = await createContributor(c);
    await contribute(c, contrib4, 2_000_000);

    account = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(
      account.milestonesFired,
      1,
      "milestones_fired must remain 1 without re-firing or corrupting flags"
    );
  });
});
