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
 * Milestones: a campaign records, once and permanently, each 25% / 50% / 75%
 * mark its running total has crossed.
 *
 * Two properties carry the feature, and each has a test here:
 *
 *   - the threshold is inclusive, so exactly 25.0% fires and one unit short
 *     does not. `>=` against `>` is invisible without both halves;
 *   - the bitmask is sticky, so a refund that drops the total back under a
 *     threshold does not re-arm it.
 *
 * Every test in this file fails against the base program, which has no
 * `milestonesReached` field at all.
 */
describe("fundraiser — milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const TARGET = 30_000_000;
  const MAX_PER_WALLET = TARGET / 10;  // the program's 10% cap
  const QUARTER = TARGET / 4;          // 7_500_000

  const MILESTONE_25 = 0b001;
  const MILESTONE_50 = 0b010;
  const MILESTONE_75 = 0b100;

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

  const openCampaign = async (durationDays = 7): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const mint = await createMint(
      provider.connection, wallet.payer, provider.publicKey, provider.publicKey, 6
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

  /**
   * Contributes `amount` from a brand new wallet.
   *
   * A fresh wallet per contribution is not decoration: the program caps each
   * contributor at 10% of the target, so reaching 25% is impossible from one
   * of them. Every milestone test needs at least three.
   */
  const contributeFrom = async (c: Campaign, amount: number) => {
    const contributor = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(contributor.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const ata = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection, wallet.payer, c.mint, contributor.publicKey
      )
    ).address;

    await mintTo(provider.connection, wallet.payer, c.mint, ata, provider.publicKey, amount);

    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), c.fundraiser.toBuffer(), contributor.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount,
        contributorAta: ata,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor])
      .rpc()
      .then(confirm);

    return { contributor, ata, contributorAccount };
  };

  const milestonesOf = async (c: Campaign): Promise<number> =>
    (await program.account.fundraiser.fetch(c.fundraiser)).milestonesReached;

  // ------------------------------------------------------------------

  it("starts with no milestones and records none below the first threshold", async () => {
    const campaign = await openCampaign();

    assert.strictEqual(await milestonesOf(campaign), 0, "a new campaign has passed nothing");

    // 20% of the target: past nothing.
    await contributeFrom(campaign, MAX_PER_WALLET);
    await contributeFrom(campaign, MAX_PER_WALLET);

    assert.strictEqual(
      await milestonesOf(campaign), 0,
      "20% of the target is below the 25% mark"
    );
  });

  it("records the 25% milestone and only that one", async () => {
    const campaign = await openCampaign();

    // 30% of the target, in three contributions.
    await contributeFrom(campaign, MAX_PER_WALLET);
    await contributeFrom(campaign, MAX_PER_WALLET);
    await contributeFrom(campaign, MAX_PER_WALLET);

    const flags = await milestonesOf(campaign);
    assert.strictEqual(flags & MILESTONE_25, MILESTONE_25, "25% should be recorded");
    assert.strictEqual(flags & MILESTONE_50, 0, "50% has not been reached");
    assert.strictEqual(flags & MILESTONE_75, 0, "75% has not been reached");
  });

  // The boundary pair. Together these are the only thing that tells `>=` from
  // `>`; either one alone passes against both implementations.

  it("fires at exactly the threshold", async () => {
    const campaign = await openCampaign();

    await contributeFrom(campaign, MAX_PER_WALLET);
    await contributeFrom(campaign, MAX_PER_WALLET);
    await contributeFrom(campaign, QUARTER - 2 * MAX_PER_WALLET);   // lands on 25.0%

    const fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fundraiser.currentAmount.toNumber(), QUARTER, "should be exactly at 25%");
    assert.strictEqual(
      fundraiser.milestonesReached & MILESTONE_25, MILESTONE_25,
      "the threshold is inclusive: exactly 25% counts as reached"
    );
  });

  it("does not fire one unit short of the threshold", async () => {
    const campaign = await openCampaign();

    await contributeFrom(campaign, MAX_PER_WALLET);
    await contributeFrom(campaign, MAX_PER_WALLET);
    await contributeFrom(campaign, QUARTER - 2 * MAX_PER_WALLET - 1);

    const fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fundraiser.currentAmount.toNumber(), QUARTER - 1, "should be one unit short");
    assert.strictEqual(
      fundraiser.milestonesReached, 0,
      "one unit below 25% has not reached it"
    );
  });

  // The abuse test lives in milestones-bankrun.ts: proving a milestone
  // survives a refund needs the window open for the contributions and closed
  // for the refund, which only a settable clock can do.
});
