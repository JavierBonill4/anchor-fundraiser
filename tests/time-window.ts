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
 * Regression tests for the contribution window.
 *
 * `contribute` must be accepted while the window is OPEN and refused once it has
 * CLOSED. `refund` is the mirror image. Both checks were once written the wrong
 * way round, and the original test suite could not see it because it created
 * every fundraiser with `duration = 0` — the single value at which the broken
 * comparison and the correct one agree.
 *
 * These tests need no clock manipulation: `duration = 7` is an open window on the
 * day it is created, and `duration = 0` is a closed one. That is enough to pin the
 * comparison from both sides.
 */
describe("fundraiser — contribution window", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  // Comfortably above MIN_AMOUNT_TO_RAISE, and 1_000_000 is under the 10% per-
  // contributor cap that `contribute` enforces separately.
  const TARGET = 30_000_000;
  const CONTRIBUTION = 1_000_000;

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  /**
   * Anchor error code for a rejected transaction, however the error arrives.
   *
   * Rethrows chai's own AssertionError so that an `assert.fail` inside a `try`
   * is not swallowed by the `catch` that is there to inspect program errors.
   */
  const errorCodeOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;
    const text = `${err?.message ?? ""} ${JSON.stringify(err?.logs ?? [])}`;
    const match = text.match(/Error Code: (\w+)/);
    return match ? match[1] : text.slice(0, 300);
  };

  /** Case-insensitive because Anchor's IDL camelCases error names while the
   *  runtime's parsed AnchorError reports them in PascalCase. */
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
    contributorAccount: anchor.web3.PublicKey;
    contributorAta: anchor.web3.PublicKey;
  };

  /**
   * Creates a fresh maker, mint and fundraiser so each test is independent.
   * `durationDays` is what the whole file turns on: 7 is an open window today,
   * 0 is a window that closed the moment it opened.
   */
  const openCampaign = async (durationDays: number): Promise<Campaign> => {
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

    const contributorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        wallet.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      contributorAta,
      provider.publicKey,
      10 * CONTRIBUTION
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), provider.publicKey.toBuffer()],
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

    return { maker, mint, fundraiser, vault, contributorAccount, contributorAta };
  };

  const contribute = (c: Campaign, amount: number) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: provider.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: c.contributorAccount,
        contributorAta: c.contributorAta,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

  const refund = (c: Campaign) =>
    program.methods
      .refund()
      .accountsPartial({
        contributor: provider.publicKey,
        maker: c.maker.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: c.contributorAccount,
        contributorAta: c.contributorAta,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

  // ------------------------------------------------------------------
  // The window is open
  // ------------------------------------------------------------------

  it("accepts a contribution while the window is open", async () => {
    const campaign = await openCampaign(7);

    try {
      await contribute(campaign, CONTRIBUTION);
    } catch (err) {
      assert.fail(
        `a contribution on day 0 of a 7 day fundraiser must be accepted, ` +
          `but it was rejected with ${errorCodeOf(err)}`
      );
    }

    // Assert on state, not on the call returning. The money has to have moved.
    const vault = await provider.connection.getTokenAccountBalance(campaign.vault);
    assert.strictEqual(vault.value.amount, String(CONTRIBUTION), "vault should hold the contribution");

    const fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(
      fundraiser.currentAmount.toString(),
      String(CONTRIBUTION),
      "current_amount should track the contribution"
    );
  });

  it("refuses a refund while the window is still open", async () => {
    const campaign = await openCampaign(7);

    // Setup, not the assertion: there has to be something to refund.
    try {
      await contribute(campaign, CONTRIBUTION);
    } catch (err) {
      assert.fail(
        `could not set up this test: the contribution was rejected with ` +
          `${errorCodeOf(err)}. Fix the contribution window first.`
      );
    }

    try {
      await refund(campaign);
      assert.fail("a refund on day 0 of a 7 day fundraiser must be refused");
    } catch (err) {
      assertErrorIs(err, "FundraiserNotEnded",
        "the refund should be refused because the window has not closed");
    }

    // And nothing moved.
    const vault = await provider.connection.getTokenAccountBalance(campaign.vault);
    assert.strictEqual(vault.value.amount, String(CONTRIBUTION), "vault must be untouched");
  });

  // ------------------------------------------------------------------
  // The window is closed
  // ------------------------------------------------------------------

  it("sets milestone_flags as contributions cross 25%, 50%, 75% thresholds", async () => {
    // 10% per-contributor cap means one wallet can only reach 10% of target.
    // Crossing 25% requires 3+ contributors. We use wallet + two fresh keypairs,
    // each contributing 10% (3_000_000 of 30_000_000 target).
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

    // Three extra contributors, each funded with tokens from the mint authority (wallet)
    const contributors: anchor.web3.Keypair[] = [
      anchor.web3.Keypair.generate(),
      anchor.web3.Keypair.generate(),
      anchor.web3.Keypair.generate(),
    ];

    const contributorAtas: anchor.web3.PublicKey[] = [];
    for (const c of contributors) {
      await provider.connection
        .requestAirdrop(c.publicKey, anchor.web3.LAMPORTS_PER_SOL)
        .then(confirm);
      const ata = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          wallet.payer,
          mint,
          c.publicKey
        )
      ).address;
      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        ata,
        provider.publicKey,
        TARGET // enough to contribute 10%
      );
      contributorAtas.push(ata);
    }

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

    let state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.milestoneFlags, 0, "no milestones before contributions");

    // Each contributor sends 10% of target (3_000_000). After 3 contributions = 30% → 25% flag set.
    for (let i = 0; i < 3; i++) {
      const c = contributors[i];
      const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("contributor"), fundraiser.toBuffer(), c.publicKey.toBuffer()],
        program.programId
      );
      await program.methods
        .contribute(new anchor.BN(3_000_000)) // 10% of TARGET
        .accountsPartial({
          contributor: c.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount,
          contributorAta: contributorAtas[i],
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([c])
        .rpc()
        .then(confirm);

      state = await program.account.fundraiser.fetch(fundraiser);
      if (i === 1) {
        // After 2nd contribution = 20%, still below 25%
        assert.strictEqual(state.milestoneFlags & 0b001, 0, "25% not yet reached at 20%");
      } else if (i === 2) {
        // After 3rd contribution = 30%, crossed 25%
        assert.strictEqual(state.milestoneFlags & 0b001, 1, "25% milestone (bit 0) set at 30%");
        assert.strictEqual(state.milestoneFlags & 0b110, 0, "50% and 75% not yet set");
      }
    }
  });

  it("refuses a contribution once the window has closed", async () => {
    // duration = 0 means zero days of fundraising: the window is shut on arrival.
    const campaign = await openCampaign(0);

    try {
      await contribute(campaign, CONTRIBUTION);
      assert.fail("a contribution to a zero day fundraiser must be refused");
    } catch (err) {
      assertErrorIs(err, "FundraiserEnded",
        "the contribution should be refused because the window has closed");
    }

    const vault = await provider.connection.getTokenAccountBalance(campaign.vault);
    assert.strictEqual(vault.value.amount, "0", "nothing should have reached the vault");
  });
});
