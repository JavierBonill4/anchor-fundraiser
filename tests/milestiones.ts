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
 * Tests for the milestone feature (Option A).
 *
 * `milestones_fired` is a u8 bitmask on the Fundraiser account:
 * bit 0 = 25%, bit 1 = 50%, bit 2 = 75%. It is computed at the end of
 * `contribute` as `current_amount * 4 / amount_to_raise`, looping over every
 * satisfied quarter so a contribution that jumps past a mark still fires it,
 * and each bit fires at most once. A `MilestoneReached` event is emitted
 * alongside the bit, for front ends to subscribe to.
 *
 * Every test below asserts on on-chain state, and every one fails with the
 * feature deleted: the first four read `milestonesFired`, which would not
 * exist, and the last asserts on the `Overflow` error the checked math
 * returns (a bare `*` would panic instead).
 */
describe("fundraiser — milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  // 40 whole tokens on a 6-decimal mint. 10% per-contributor cap = 4M, so
  // each contributor below stays within the cap and 25% lands exactly on
  // 10M — a round boundary with no rounding ambiguity.
  const TARGET = 40_000_000;
  const MAX_PER_CONTRIBUTOR = 4_000_000;

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
    contributorAccount: anchor.web3.PublicKey;
    contributorAta: anchor.web3.PublicKey;
  };

  const openCampaign = async (target: anchor.BN): Promise<Campaign> => {
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
      .initialize(target, 7)
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

    // Fresh campaigns start with no milestone fired.
    const opened = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(
      opened.milestonesFired,
      0,
      "a new fundraiser must start with no milestones fired"
    );

    return { maker, mint, fundraiser, vault };
  };

  const addBacker = async (
    campaign: Campaign,
    fundAmount: number
  ): Promise<Backer> => {
    const keypair = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(keypair.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const contributorAta = (
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
      contributorAta,
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

    return { keypair, contributorAccount, contributorAta };
  };

  const contribute = (campaign: Campaign, backer: Backer, amount: number) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: backer.keypair.publicKey,
        mintToRaise: campaign.mint,
        fundraiser: campaign.fundraiser,
        contributorAccount: backer.contributorAccount,
        contributorAta: backer.contributorAta,
        vault: campaign.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([backer.keypair])
      .rpc()
      .then(confirm);

  it("fires the 25% milestone exactly at the boundary", async () => {
    const campaign = await openCampaign(new anchor.BN(TARGET));
    const a = await addBacker(campaign, 10 * MAX_PER_CONTRIBUTOR);
    const b = await addBacker(campaign, 10 * MAX_PER_CONTRIBUTOR);
    const c = await addBacker(campaign, 10 * MAX_PER_CONTRIBUTOR);

    await contribute(campaign, a, 4_000_000);
    await contribute(campaign, b, 4_000_000);
    // 8M of 40M = 20%: no milestone yet.
    let state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(state.milestonesFired, 0, "20% must not fire 25%");

    await contribute(campaign, c, 2_000_000);
    // Exactly 10M of 40M = 25%: bit 0 set.
    state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(
      state.currentAmount.toString(),
      "10000000",
      "vault total should be exactly 25% of target"
    );
    assert.strictEqual(state.milestonesFired, 1, "25% must set bit 0");
  });

  it("stays silent one token-unit below 25%", async () => {
    const campaign = await openCampaign(new anchor.BN(TARGET));
    const a = await addBacker(campaign, 10 * MAX_PER_CONTRIBUTOR);
    const b = await addBacker(campaign, 10 * MAX_PER_CONTRIBUTOR);
    const c = await addBacker(campaign, 10 * MAX_PER_CONTRIBUTOR);

    await contribute(campaign, a, 4_000_000);
    await contribute(campaign, b, 4_000_000);
    await contribute(campaign, c, 1_999_999);
    // 9,999,999 of 40M is a hair under 25%: nothing fires.
    const state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(
      state.currentAmount.toString(),
      "9999999",
      "total should sit just below the quarter mark"
    );
    assert.strictEqual(state.milestonesFired, 0, "below 25% nothing may fire");
  });

  it("fires 25% and 50% as the total climbs past both (happy path)", async () => {
    const campaign = await openCampaign(new anchor.BN(TARGET));
    const backers: Backer[] = [];
    for (let i = 0; i < 6; i++) {
      backers.push(await addBacker(campaign, 10 * MAX_PER_CONTRIBUTOR));
    }

    for (let i = 0; i < 3; i++) {
      await contribute(campaign, backers[i], MAX_PER_CONTRIBUTOR);
    }
    // 12M of 40M = 30%: only the quarter mark.
    let state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(state.milestonesFired, 1, "30% must show only 25%");

    for (let i = 3; i < 6; i++) {
      await contribute(campaign, backers[i], MAX_PER_CONTRIBUTOR);
    }
    // 24M of 40M = 60%: quarter and half marks, bits 0 and 1.
    state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(
      state.currentAmount.toString(),
      "24000000",
      "total should be 60% of target"
    );
    assert.strictEqual(state.milestonesFired, 3, "60% must show 25% and 50%");
  });

  it("never fires the same milestone twice", async () => {
    const campaign = await openCampaign(new anchor.BN(TARGET));
    const a = await addBacker(campaign, 10 * MAX_PER_CONTRIBUTOR);
    const b = await addBacker(campaign, 10 * MAX_PER_CONTRIBUTOR);
    const c = await addBacker(campaign, 10 * MAX_PER_CONTRIBUTOR);
    const d = await addBacker(campaign, 10 * MAX_PER_CONTRIBUTOR);

    await contribute(campaign, a, 4_000_000);
    await contribute(campaign, b, 4_000_000);
    await contribute(campaign, c, 2_000_000);
    let state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(state.milestonesFired, 1, "setup: 25% fired");

    // Another 4M takes the total to 14M (35%) — still below half, so the
    // bitmask must be untouched. Without the flag guard this is where a
    // naive `emit on every contribute past the mark` implementation
    // re-fires the quarter event.
    await contribute(campaign, d, 4_000_000);
    state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(
      state.milestonesFired,
      1,
      "a later contribution must not re-fire 25%"
    );
  });

  it("fails a contribution that overflows the cap math with Overflow (abuse)", async () => {
    // A target near u64::MAX makes `amount_to_raise * 10` unrepresentable.
    // Checked math must return our named error instead of panicking.
    const campaign = await openCampaign(
      new anchor.BN("18446744073709551615")
    );
    const attacker = await addBacker(campaign, 10_000_000);

    try {
      await contribute(campaign, attacker, 1_000_000);
      assert.fail("a contribution past u64 range must be refused");
    } catch (err) {
      assertErrorIs(
        err,
        "Overflow",
        "overflowing the per-contributor cap must fail with Overflow"
      );
    }
  });
});