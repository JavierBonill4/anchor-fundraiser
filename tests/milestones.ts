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

/**
 * Proves the milestone feature: milestones_fired flips one bit per quarter
 * mark, exactly once, and a MilestoneReached event fires alongside it.
 *
 * Uses a 0-decimal mint so "one token" and "one raw unit" are the same
 * thing — that gives exact integer control over the 25% boundary without
 * fighting the contribute() minimum-contribution check.
 *
 * A single contribution is capped at 10% of the target, so no one
 * contributor can cross a 25% mark alone: every campaign below is raised
 * by several distinct contributor keypairs, each staying under that cap,
 * mirroring how the real program is meant to be used.
 */
describe("fundraiser — milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  // 0 decimals: "1 token" == 1 raw unit == the smallest contribution allowed.
  const DECIMALS = 0;
  // 10% of TARGET = 4, so a quarter (10) needs at least 3 contributors.
  const TARGET = 40;
  const MAX_PER_CONTRIBUTOR = 4;

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  const errorCodeOf = (err: any): string => {
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

  /** A fresh 0-decimal-mint campaign with its own maker, so tests never share state. */
  const openCampaign = async (): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      DECIMALS
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new anchor.BN(TARGET), 7)
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

  /** A funded contributor keypair with its own ATA, ready to contribute to `c`. */
  const newContributor = async (c: Campaign) => {
    const kp = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(kp.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const ata = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        c.mint,
        kp.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      c.mint,
      ata,
      provider.publicKey,
      MAX_PER_CONTRIBUTOR
    );

    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), c.fundraiser.toBuffer(), kp.publicKey.toBuffer()],
      program.programId
    );

    return { kp, ata, contributorAccount };
  };

  const contribute = (
    c: Campaign,
    contributor: { kp: anchor.web3.Keypair; ata: anchor.web3.PublicKey; contributorAccount: anchor.web3.PublicKey },
    amount: number
  ) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.kp.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: contributor.contributorAccount,
        contributorAta: contributor.ata,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor.kp])
      .rpc()
      .then(confirm);

  // ------------------------------------------------------------------

  it("fires the 25% milestone once the vault crosses it, with an event", async () => {
    const campaign = await openCampaign();

    let seen: any = null;
    const listenerId = program.addEventListener("milestoneReached", (event) => {
      seen = event;
    });

    try {
      // 4 + 4 + 2 = 10 = exactly TARGET/4.
      for (const amount of [4, 4, 2]) {
        const c = await newContributor(campaign);
        await contribute(campaign, c, amount);
      }

      // Give the event a moment to arrive over the websocket subscription.
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      await program.removeEventListener(listenerId);
    }

    const fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(
      fundraiser.milestonesFired,
      0b001,
      "only the 25% bit should be set at exactly 25%"
    );
    assert.strictEqual(fundraiser.currentAmount.toString(), "10");

    assert.isNotNull(seen, "MilestoneReached should have been emitted");
    assert.strictEqual(seen.milestonePercent, 25);
    assert.strictEqual(seen.currentAmount.toString(), "10");
  });

  it("does not fire one unit below the mark, and fires exactly at it", async () => {
    const campaign = await openCampaign();

    // 4 + 4 + 1 = 9 — one below the 10-unit quarter mark.
    for (const amount of [4, 4, 1]) {
      const c = await newContributor(campaign);
      await contribute(campaign, c, amount);
    }

    let fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fundraiser.currentAmount.toString(), "9");
    assert.strictEqual(
      fundraiser.milestonesFired,
      0,
      "no milestone should have fired one unit below the mark"
    );

    // One more unit takes it to exactly 10 — the mark itself.
    const last = await newContributor(campaign);
    await contribute(campaign, last, 1);

    fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fundraiser.currentAmount.toString(), "10");
    assert.strictEqual(
      fundraiser.milestonesFired,
      0b001,
      "the 25% bit should be set exactly at the mark"
    );
  });

  it("does not re-fire a mark on later contributions within the same quarter", async () => {
    const campaign = await openCampaign();

    // Cross 25% first.
    for (const amount of [4, 4, 2]) {
      const c = await newContributor(campaign);
      await contribute(campaign, c, amount);
    }

    let fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fundraiser.milestonesFired, 0b001);

    let eventCount = 0;
    const listenerId = program.addEventListener("milestoneReached", () => {
      eventCount += 1;
    });

    try {
      // Contribute again, staying under 50% (14 total, still quarter 1).
      const again = await newContributor(campaign);
      await contribute(campaign, again, 4);

      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      await program.removeEventListener(listenerId);
    }

    fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fundraiser.currentAmount.toString(), "14");
    assert.strictEqual(
      fundraiser.milestonesFired,
      0b001,
      "the bit must not be cleared or re-set by a contribution that doesn't cross a new mark"
    );
    assert.strictEqual(eventCount, 0, "no MilestoneReached should fire without crossing a new mark");
  });

  it("rejects a contribution above the per-tx cap with the original error (nothing else broke)", async () => {
    const campaign = await openCampaign();
    const c = await newContributor(campaign);

    try {
      // MAX_PER_CONTRIBUTOR + 1 exceeds the 10% cap.
      await contribute(campaign, c, MAX_PER_CONTRIBUTOR + 1);
      assert.fail("a contribution above the 10% cap must be refused");
    } catch (err) {
      assert.strictEqual(
        errorCodeOf(err).toLowerCase(),
        "contributiontoobig",
        `expected ContributionTooBig, got ${errorCodeOf(err)}`
      );
    }
  });
});
