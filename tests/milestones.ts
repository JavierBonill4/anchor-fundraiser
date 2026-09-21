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
 * Quarter milestones at 25% / 50% / 75% of the target.
 *
 * Each milestone is a bit in `milestones_fired` (bit 0 = 25%, bit 1 = 50%,
 * bit 2 = 75%) set inline at the end of `contribute`, plus a `MilestoneReached`
 * event a front end can subscribe to. Bits are one-way: a later refund never
 * clears one.
 *
 * The per-contributor cap is 10% of the target, so every test below uses
 * several distinct contributors — one contributor alone can never push a
 * 40-token campaign past a quarter mark.
 */
describe("fundraiser — quarter milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const TARGET = 40_000_000; // 40 tokens on a 6-decimal mint
  const MAX_PER = 4_000_000; // 10% of TARGET
  const QUARTER = TARGET / 4; // 10_000_000
  const HALF = TARGET / 2; // 20_000_000

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
      `${why} (expected ${expected}, got ${actual})`
    );
  };

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  type Backer = {
    keypair: anchor.web3.Keypair;
    ata: anchor.web3.PublicKey;
    contributorAccount: anchor.web3.PublicKey;
  };

  const openCampaign = async (
    target: number | anchor.BN = TARGET,
    durationDays = 7
  ): Promise<Campaign> => {
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

    const targetBn =
      typeof target === "number" ? new anchor.BN(target) : target;
    await program.methods
      .initialize(targetBn, durationDays)
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

    // A fresh campaign starts with no milestone fired.
    const account = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(
      account.milestonesFired,
      0,
      "a new fundraiser must start with milestonesFired == 0"
    );

    return { maker, mint, fundraiser, vault };
  };

  /** Fresh funded backer for `campaign` holding `fundAmount` tokens. */
  const newBacker = async (
    campaign: Campaign,
    fundAmount: number
  ): Promise<Backer> => {
    const keypair = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(keypair.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const ata = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        campaign.mint,
        keypair.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      campaign.mint,
      ata,
      provider.publicKey,
      fundAmount
    );

    const [contributorAccount] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          campaign.fundraiser.toBuffer(),
          keypair.publicKey.toBuffer(),
        ],
        program.programId
      );

    return { keypair, ata, contributorAccount };
  };

  const contributeAs = (campaign: Campaign, backer: Backer, amount: number) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: backer.keypair.publicKey,
        mintToRaise: campaign.mint,
        fundraiser: campaign.fundraiser,
        contributorAccount: backer.contributorAccount,
        contributorAta: backer.ata,
        vault: campaign.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([backer.keypair])
      .rpc()
      .then(confirm);

  const milestonesOf = async (campaign: Campaign): Promise<number> => {
    const account = await program.account.fundraiser.fetch(
      campaign.fundraiser
    );
    return account.milestonesFired;
  };

  const totalOf = async (campaign: Campaign): Promise<string> => {
    const account = await program.account.fundraiser.fetch(
      campaign.fundraiser
    );
    return account.currentAmount.toString();
  };

  // ------------------------------------------------------------------
  // Happy path: sequential contributions fire 25% then 50%.
  // ------------------------------------------------------------------

  it("fires 25% and then 50% as the vault fills", async () => {
    const campaign = await openCampaign();

    // 2 x 4M = 8M (20%): below the first mark, nothing fires.
    const early: Backer[] = [];
    for (let i = 0; i < 2; i++) {
      const b = await newBacker(campaign, MAX_PER);
      await contributeAs(campaign, b, MAX_PER);
      early.push(b);
    }
    assert.strictEqual(await totalOf(campaign), String(2 * MAX_PER));
    assert.strictEqual(
      await milestonesOf(campaign),
      0,
      "20% of target must not fire any milestone"
    );

    // 3rd x 4M = 12M (30%): crosses 25%, fires bit 0 only.
    const third = await newBacker(campaign, MAX_PER);
    await contributeAs(campaign, third, MAX_PER);
    assert.strictEqual(await totalOf(campaign), String(3 * MAX_PER));
    assert.strictEqual(
      await milestonesOf(campaign),
      0b001,
      "30% of target must have fired exactly the 25% milestone"
    );

    // 4th + 5th x 4M = 20M (50%): crosses the half, fires bit 1 too.
    // A single contribution can never skip a whole quarter under the 10%
    // per-contributor cap, so the loop shape is exercised across txs here.
    for (let i = 0; i < 2; i++) {
      const b = await newBacker(campaign, MAX_PER);
      await contributeAs(campaign, b, MAX_PER);
    }
    assert.strictEqual(await totalOf(campaign), String(HALF));
    assert.strictEqual(
      await milestonesOf(campaign),
      0b011,
      "50% of target must have fired the 25% and 50% milestones"
    );
  });

  // ------------------------------------------------------------------
  // Boundary: one raw unit below 25% is silent, exactly 25% fires.
  // ------------------------------------------------------------------

  it("stays silent one unit below 25% and fires exactly at 25%", async () => {
    // Minimum contribution is one whole token (1M raw), so a single campaign
    // cannot step from QUARTER-1 to QUARTER — that last step would be 1 raw
    // unit and rejected as ContributionTooSmall. Two sibling campaigns pin the
    // boundary from both sides instead: one lands a unit short, one lands on
    // it. Both use only legal (>= 1M, <= 10%) contributions.
    const below = await openCampaign();
    const a = await newBacker(below, MAX_PER);
    await contributeAs(below, a, MAX_PER); // 4M
    const b = await newBacker(below, MAX_PER);
    await contributeAs(below, b, MAX_PER); // 8M
    // 8M + 1,999,999 = 9,999,999 — one raw unit short of the quarter.
    const c = await newBacker(below, MAX_PER);
    await contributeAs(below, c, QUARTER - 2 * MAX_PER - 1);
    assert.strictEqual(await totalOf(below), String(QUARTER - 1));
    assert.strictEqual(
      await milestonesOf(below),
      0,
      "one unit below 25% must not fire anything (tests >=, not >)"
    );

    // Exactly 10M: 4M + 4M + 2M. Same shape, one unit more in the last leg.
    const exact = await openCampaign();
    const d = await newBacker(exact, MAX_PER);
    await contributeAs(exact, d, MAX_PER);
    const e = await newBacker(exact, MAX_PER);
    await contributeAs(exact, e, MAX_PER);
    const f = await newBacker(exact, MAX_PER);
    await contributeAs(exact, f, QUARTER - 2 * MAX_PER);
    assert.strictEqual(await totalOf(exact), String(QUARTER));
    assert.strictEqual(
      await milestonesOf(exact),
      0b001,
      "exactly 25% must fire the first milestone"
    );
  });

  // ------------------------------------------------------------------
  // Abuse / idempotency: a milestone fires once, ever.
  // ------------------------------------------------------------------

  it("does not fire the same milestone twice", async () => {
    const campaign = await openCampaign();

    // Reach 12M (30%): first milestone fired.
    for (let i = 0; i < 3; i++) {
      const b = await newBacker(campaign, MAX_PER);
      await contributeAs(campaign, b, MAX_PER);
    }
    assert.strictEqual(await milestonesOf(campaign), 0b001);

    // Another 1M stays inside the same quarter (13M = 32.5%): the
    // contribution must succeed and grow the total, but the flags must not
    // move. Without the bit check this would re-emit / double-count.
    const extra = await newBacker(campaign, MAX_PER);
    await contributeAs(campaign, extra, 1_000_000);
    assert.strictEqual(
      await totalOf(campaign),
      String(3 * MAX_PER + 1_000_000),
      "the extra contribution must still land in the vault"
    );
    assert.strictEqual(
      await milestonesOf(campaign),
      0b001,
      "a second contribution in the same quarter must not re-fire it"
    );

    // One more small top-up from the same backer: still no new milestone.
    await contributeAs(campaign, extra, 1_000_000);
    assert.strictEqual(
      await milestonesOf(campaign),
      0b001,
      "repeating the contribution must leave the flags untouched"
    );
  });

  // ------------------------------------------------------------------
  // Abuse with the new error: token math is checked, not panicking.
  // ------------------------------------------------------------------

  it("rejects contributions that would overflow with Overflow", async () => {
    // A target near u64::MAX makes `target * 10` overflow. Checked math must
    // return our Overflow error instead of panicking on overflow-checks.
    const huge = new anchor.BN("18446744073709551615");
    const campaign = await openCampaign(huge);

    const backer = await newBacker(campaign, 1_000_000);
    try {
      await contributeAs(campaign, backer, 1_000_000);
      assert.fail("a contribution that overflows 10% math must be rejected");
    } catch (err) {
      assertErrorIs(
        err,
        "Overflow",
        "overflowing token math must fail with the Overflow error"
      );
    }
  });
});
