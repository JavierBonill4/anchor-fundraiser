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
 * Funding milestones: the 25%, 50% and 75% marks fire once each, at the end
 * of `contribute`, and are recorded as a bitmask on the fundraiser account.
 *
 * Two existing rules shape every number below. `contribute` caps any one
 * contributor at 10% of the target and refuses less than one whole token, so
 * a fresh backer is needed for every 3_000_000 and no deposit can be smaller
 * than 1_000_000. Reaching a quarter of a 30_000_000 target therefore takes
 * three backers, and one of them has to stop short of the cap to land on it.
 */
describe("fundraiser — funding milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const TARGET = 30_000_000;
  const CAP = 3_000_000;          // 10% of TARGET, the per-contributor limit

  const QUARTER = 0b001;          // bit 0
  const HALF = 0b010;             // bit 1

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  /**
   * Anchor error code for a rejected transaction, however the error arrives.
   * Rethrows chai's own AssertionError so an `assert.fail` inside a `try` is
   * not swallowed by the `catch` that is there to inspect program errors.
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
    kp: anchor.web3.Keypair;
    ata: anchor.web3.PublicKey;
    contributorAccount: anchor.web3.PublicKey;
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
      6
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

  /** A fresh wallet holding exactly one cap's worth of the campaign's mint. */
  const newBacker = async (c: Campaign): Promise<Backer> => {
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

    await mintTo(provider.connection, wallet.payer, c.mint, ata, provider.publicKey, CAP);

    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), c.fundraiser.toBuffer(), kp.publicKey.toBuffer()],
      program.programId
    );
    return { kp, ata, contributorAccount };
  };

  const contributeAs = (c: Campaign, b: Backer, amount: number) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: b.kp.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: b.contributorAccount,
        contributorAta: b.ata,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([b.kp])
      .rpc()
      .then(confirm);

  const contributeCap = async (c: Campaign) =>
    contributeAs(c, await newBacker(c), CAP);

  const checkMilestone = (c: Campaign, index: number) =>
    program.methods
      .checkMilestone(index)
      .accountsPartial({ fundraiser: c.fundraiser })
      .rpc();

  const state = async (c: Campaign) => {
    const f = await program.account.fundraiser.fetch(c.fundraiser);
    return { fired: f.milestonesFired, current: f.currentAmount.toNumber() };
  };

  // One campaign, carried through the tests in order. Each test starts from
  // the total the previous one left behind, and says so.
  let c: Campaign;

  // ------------------------------------------------------------------
  // Boundary: just under the first mark
  // ------------------------------------------------------------------

  it("leaves every milestone unfired at 20% of the target", async () => {
    c = await openCampaign();
    await contributeCap(c);   // 3_000_000 = 10%
    await contributeCap(c);   // 6_000_000 = 20%

    const s = await state(c);
    assert.strictEqual(s.current, 6_000_000, "two capped backers");
    assert.strictEqual(s.fired, 0, "no mark is satisfied at 20%");

    try {
      await checkMilestone(c, 0);
      assert.fail("check_milestone(0) must be refused before the 25% mark");
    } catch (err) {
      assertErrorIs(err, "MilestoneNotReached", "20% is under the first mark");
    }
  });

  // ------------------------------------------------------------------
  // Happy path: exactly on the first mark
  // ------------------------------------------------------------------

  it("fires the 25% milestone at exactly a quarter of the target", async () => {
    // 6_000_000 + 1_500_000 = 7_500_000, which is TARGET / 4 to the unit.
    await contributeAs(c, await newBacker(c), 1_500_000);

    const s = await state(c);
    assert.strictEqual(s.current, 7_500_000, "exactly a quarter");
    assert.strictEqual(s.fired, QUARTER, "bit 0 set, bits 1 and 2 clear");

    // The guard is the positive control for the abuse test below.
    await checkMilestone(c, 0);
  });

  // ------------------------------------------------------------------
  // The trap: a contribution can jump past a mark without landing on it
  // ------------------------------------------------------------------

  it("fires the 50% milestone from a contribution that jumps over it", async () => {
    await contributeCap(c);   // 10_500_000 = 35%
    await contributeCap(c);   // 13_500_000 = 45%

    const before = await state(c);
    assert.strictEqual(before.current, 13_500_000);
    assert.strictEqual(before.fired, QUARTER, "still only the first mark at 45%");

    // 45% -> 55%. The vault is never at 50%; the check has to be "which marks
    // are satisfied and unfired", not "did this deposit land on a boundary".
    await contributeCap(c);

    const after = await state(c);
    assert.strictEqual(after.current, 16_500_000, "55% of target");
    assert.strictEqual(after.fired, QUARTER | HALF, "the jumped-over mark fired");
  });

  // ------------------------------------------------------------------
  // Abuse: asking the guard for a mark that has not fired, or does not exist
  // ------------------------------------------------------------------

  it("check_milestone refuses an unreached mark and an out-of-range index", async () => {
    // Positive control: 50% has fired, so the guard passes for it.
    await checkMilestone(c, 1);

    try {
      await checkMilestone(c, 2);
      assert.fail("75% has not fired at 55%");
    } catch (err) {
      assertErrorIs(err, "MilestoneNotReached", "the third mark is still ahead");
    }

    try {
      await checkMilestone(c, 3);
      assert.fail("there is no fourth milestone");
    } catch (err) {
      assertErrorIs(err, "InvalidMilestone", "index 3 is out of range");
    }

    const s = await state(c);
    assert.strictEqual(s.fired, QUARTER | HALF, "a failed guard changes nothing");
  });
});
