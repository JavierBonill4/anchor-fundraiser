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
 * The tiered contribution cap.
 *
 * Today a single contributor may hold at most 10% of the target. This feature
 * makes that cap a function of how full the vault already is:
 *
 *     vault < 50% of target  ->  10% of target per contributor
 *     50% <= vault < 75%     ->  20%
 *     vault >= 75%           ->  30%
 *
 * The tier is read from the vault *before* this contribution lands, so a
 * contribution that crosses a threshold is still held to the tier it leaves
 * behind. Refunds shrink `current_amount`, and because the tier is derived
 * rather than stored it honestly shrinks with it - it can never claim a level
 * the vault no longer justifies.
 *
 * All amounts are raw units on a 6-decimal mint, so three tokens is 3_000_000.
 * TARGET is 30 tokens: 10% is 3_000_000, 20% is 6_000_000, and 50% is
 * 15_000_000 exactly, which is what lines the tier boundary up.
 */
describe("fundraiser - tiered contribution cap", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const TARGET = 30_000_000; // 30 tokens
  const CREDIT = 10_000_000; // tokens minted to each contributor
  const CAP_10 = 3_000_000;
  const CAP_20 = 6_000_000;
  const HALF = 15_000_000; // exact 50% line for the 30-token target

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  /**
   * Anchor error code for a rejected transaction, however the error arrives.
   */
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

  type Contributor = {
    keypair: anchor.web3.Keypair;
    ata: anchor.web3.PublicKey;
    contributorAccount: anchor.web3.PublicKey;
  };

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
    contributors: Contributor[];
  };

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
      6,
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId,
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

    return { maker, mint, fundraiser, vault, contributors: [] };
  };

  /** A fresh wallet holding `CREDIT` tokens, ready to back the campaign. */
  const newContributor = async (c: Campaign): Promise<Contributor> => {
    const keypair = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(keypair.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const ata = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        c.mint,
        keypair.publicKey,
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      c.mint,
      ata,
      provider.publicKey,
      CREDIT,
    );

    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        c.fundraiser.toBuffer(),
        keypair.publicKey.toBuffer(),
      ],
      program.programId,
    );

    const contributor = { keypair, ata, contributorAccount };
    c.contributors.push(contributor);
    return contributor;
  };

  const contribute = (c: Campaign, contributor: Contributor, amount: number) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.keypair.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: contributor.contributorAccount,
        contributorAta: contributor.ata,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor.keypair])
      .rpc();

  // ------------------------------------------------------------------
  // The base tier still holds below the halfway mark
  // ------------------------------------------------------------------

  it("keeps the 10% cap for a single contribution and in total", async () => {
    const campaign = await openCampaign();
    const alice = await newContributor(campaign);

    // 10% of the target in one go is still fine.
    await contribute(campaign, alice, CAP_10);
    assert.strictEqual(
      (await provider.connection.getTokenAccountBalance(campaign.vault)).value
        .amount,
      String(CAP_10),
      "the first contribution should land in the vault",
    );

    // A second contribution that would take her over 10% is refused.
    try {
      await contribute(campaign, alice, CAP_10 / 3);
      assert.fail("a cumulative total above the base cap must be refused");
    } catch (err) {
      assertErrorIs(
        err,
        "MaximumContributionsReached",
        "the cumulative cap should still bind below the halfway mark",
      );
    }
  });

  it("refuses a single oversized contribution before a threshold is crossed", async () => {
    const campaign = await openCampaign();

    // Four backers at 3 tokens take the vault to exactly 40% of the target.
    for (let i = 0; i < 4; i++) {
      await contribute(campaign, await newContributor(campaign), CAP_10);
    }
    assert.strictEqual(
      (await provider.connection.getTokenAccountBalance(campaign.vault)).value
        .amount,
      String(4 * CAP_10),
      "the vault should sit at 40%",
    );

    // A single 4-token contribution would cross the halfway mark, but the tier
    // is read from where the vault IS, not where this contribution would take
    // it - so 4 tokens is still over the 10% cap and must be refused.
    try {
      await contribute(
        campaign,
        await newContributor(campaign),
        CAP_10 + CAP_10 / 3,
      );
      assert.fail("a contribution must not claim the tier it crosses into");
    } catch (err) {
      assertErrorIs(
        err,
        "ContributionTooBig",
        "the base tier applies until the vault actually reaches the half",
      );
    }

    assert.strictEqual(
      (await provider.connection.getTokenAccountBalance(campaign.vault)).value
        .amount,
      String(4 * CAP_10),
      "nothing should have moved",
    );
  });

  // ------------------------------------------------------------------
  // At the halfway mark the cap relaxes - the heart of the feature
  // ------------------------------------------------------------------

  it("expands the cap to 20% once the vault is exactly half full", async () => {
    const campaign = await openCampaign();

    // Five backers at 3 tokens each land the vault exactly on 50%.
    let bob!: Contributor;
    for (let i = 0; i < 5; i++) {
      const contributor = await newContributor(campaign);
      await contribute(campaign, contributor, CAP_10);
      if (i === 1) bob = contributor;
    }
    assert.strictEqual(
      (await provider.connection.getTokenAccountBalance(campaign.vault)).value
        .amount,
      String(HALF),
      "the vault should sit exactly at 50% - the tier boundary",
    );

    // Bob already holds 3 tokens: a flat 10% cap would stop her right here.
    // The half unlocks 20%, so she may back another 3 tokens.
    try {
      await contribute(campaign, bob, CAP_10);
    } catch (err) {
      assert.fail(
        `at exactly 50% the 20% tier should be live, but this contribution ` +
          `was rejected with ${errorCodeOf(err)}`,
      );
    }

    const fundraiser = await program.account.fundraiser.fetch(
      campaign.fundraiser,
    );
    assert.strictEqual(
      fundraiser.currentAmount.toString(),
      String(HALF + CAP_10),
      "current_amount should track the new contribution",
    );

    const bobAccount = await program.account.contributor.fetch(
      bob.contributorAccount,
    );
    assert.strictEqual(
      bobAccount.amount.toString(),
      String(2 * CAP_10),
      "bob should now hold the full 20% cap",
    );
  });

  // ------------------------------------------------------------------
  // The 20% tier is a ceiling, not a promise
  // ------------------------------------------------------------------

  it("lets a fresh backer in at the higher tier but still caps them at 20%", async () => {
    const campaign = await openCampaign();

    // Reopen the same geometry: five backers land the vault on 50%.
    for (let i = 0; i < 5; i++) {
      await contribute(campaign, await newContributor(campaign), CAP_10);
    }

    // A new backer drops 4 tokens in a single transaction: above the old 10%
    // cap, comfortably inside the new 20% cap.
    const carol = await newContributor(campaign);
    try {
      await contribute(campaign, carol, CAP_10 + CAP_10 / 3);
    } catch (err) {
      assert.fail(
        `at over 50% a 4-token contribution should be accepted, but it was ` +
          `rejected with ${errorCodeOf(err)}`,
      );
    }

    // ...but her cumulative total is hard-capped at 6 tokens. A third token on
    // top would take her to 7 - that has to fail.
    try {
      await contribute(campaign, carol, CAP_10);
      assert.fail("the 20% tier must still impose a ceiling");
    } catch (err) {
      assertErrorIs(
        err,
        "MaximumContributionsReached",
        "the 20% tier caps cumulative contributions at 6 tokens",
      );
    }
  });
});
