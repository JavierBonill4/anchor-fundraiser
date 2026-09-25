import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { assert, AssertionError } from "chai";

/**
 * Tests for maker-initiated cancellation.
 *
 * The gap this feature closes: `refund` only opens once `duration` days have
 * elapsed AND the target was missed. So if a maker abandons a campaign on day
 * one, every contributor's money sits locked until the clock runs out, with no
 * way to release it early. `cancel` is that release — the maker gives up, and
 * refunds open immediately.
 *
 * Like `time-window.ts`, these tests need no clock manipulation: `duration = 7`
 * is an open window on the day it is created, so any refund that succeeds here
 * succeeded *because* of the cancellation and not because time passed.
 */
describe("fundraiser — maker cancellation", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const TARGET = 30_000_000;
  const CONTRIBUTION = 1_000_000;

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  /** Rethrows chai's AssertionError so an `assert.fail` inside a `try` is not
   *  swallowed by the `catch` that exists to inspect program errors. */
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
    contributorAccount: anchor.web3.PublicKey;
    contributorAta: anchor.web3.PublicKey;
  };

  /** A fresh maker, mint and fundraiser, so every test is independent. */
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
      6,
    );

    const contributorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        wallet.publicKey,
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      contributorAta,
      provider.publicKey,
      10 * CONTRIBUTION,
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId,
    );
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        fundraiser.toBuffer(),
        provider.publicKey.toBuffer(),
      ],
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

    return {
      maker,
      mint,
      fundraiser,
      vault,
      contributorAccount,
      contributorAta,
    };
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

  /** `signer` defaults to the real maker; pass another keypair to impersonate. */
  const cancel = (c: Campaign, signer: anchor.web3.Keypair = c.maker) =>
    program.methods
      .cancel()
      .accountsPartial({
        maker: signer.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        vault: c.vault,
      })
      .signers([signer])
      .rpc();

  const vaultBalance = async (c: Campaign) =>
    (await getAccount(provider.connection, c.vault)).amount;

  // ── the happy path ───────────────────────────────────────────────────
  //
  // The point of the whole feature: cancelling releases contributors before the
  // deadline. The window here is seven days wide and untouched, so a refund can
  // only succeed because of the cancellation.
  it("lets the maker cancel, which refunds contributors before the deadline", async () => {
    const c = await openCampaign(7);

    await contribute(c, CONTRIBUTION).then(confirm);
    assert.strictEqual(
      await vaultBalance(c),
      BigInt(CONTRIBUTION),
      "the contribution should be sitting in the vault",
    );

    // Before cancelling, a refund is refused — this is the state the feature exists
    // to escape, and asserting it here is what proves the refund below is caused by
    // the cancellation rather than by the clock.
    try {
      await refund(c);
      assert.fail(
        "a refund inside an open, uncancelled window must be refused",
      );
    } catch (err) {
      assertErrorIs(
        err,
        "FundraiserNotEnded",
        "the window is still open and the campaign is not cancelled",
      );
    }

    await cancel(c).then(confirm);

    const state = await program.account.fundraiser.fetch(c.fundraiser);
    assert.isTrue(state.cancelled, "the fundraiser should be marked cancelled");

    // And now the same refund goes through, inside the same open window.
    await refund(c).then(confirm);

    assert.strictEqual(
      await vaultBalance(c),
      0n,
      "the vault should be empty after the contributor refunds",
    );
  });

  // ── the boundary ─────────────────────────────────────────────────────
  //
  // Cancelling is only available while the campaign can still fail. Once the
  // vault reaches the target the money is the maker's to claim, and letting them
  // cancel instead would strand funds that contributors successfully raised.
  // TARGET is set to exactly one contribution so the vault lands *on* the target
  // rather than past it — the boundary itself, where `<` and `<=` disagree.
  it("refuses to cancel once the vault has reached the target", async () => {
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

    // `contribute` caps any single contributor at 10% of the target, so reaching
    // 100% takes ten distinct contributors. Each gets their own wallet, ATA and
    // contributor PDA.
    const CONTRIBUTORS = 10;
    const target = CONTRIBUTION * CONTRIBUTORS;

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId,
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new anchor.BN(target), 7)
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

    // Fill the vault to exactly the target — not one unit over. This is the
    // boundary itself, the value at which `<` and `<=` disagree, so it pins
    // which comparison `cancel` uses.
    for (let i = 0; i < CONTRIBUTORS; i++) {
      const backer = anchor.web3.Keypair.generate();
      await provider.connection
        .requestAirdrop(backer.publicKey, anchor.web3.LAMPORTS_PER_SOL)
        .then(confirm);

      const backerAta = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          wallet.payer,
          mint,
          backer.publicKey,
        )
      ).address;
      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        backerAta,
        provider.publicKey,
        CONTRIBUTION,
      );

      const [backerAccount] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          fundraiser.toBuffer(),
          backer.publicKey.toBuffer(),
        ],
        program.programId,
      );

      await program.methods
        .contribute(new anchor.BN(CONTRIBUTION))
        .accountsPartial({
          contributor: backer.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount: backerAccount,
          contributorAta: backerAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([backer])
        .rpc()
        .then(confirm);
    }

    const balance = (await getAccount(provider.connection, vault)).amount;
    assert.strictEqual(
      balance,
      BigInt(target),
      "the vault should hold exactly the target, no more",
    );

    const c: Campaign = {
      maker,
      mint,
      fundraiser,
      vault,
      contributorAccount: anchor.web3.PublicKey.default,
      contributorAta: anchor.web3.PublicKey.default,
    };

    try {
      await cancel(c);
      assert.fail(
        "cancelling a campaign that has reached its target must be refused",
      );
    } catch (err) {
      assertErrorIs(
        err,
        "TargetMet",
        "the vault is exactly at the target, so the campaign has succeeded",
      );
    }

    const state = await program.account.fundraiser.fetch(fundraiser);
    assert.isFalse(state.cancelled, "a refused cancel must not set the flag");
  });

  // ── the abuse case ───────────────────────────────────────────────────
  //
  // Anyone other than the maker trying to cancel. This is the check that stops a
  // stranger griefing a campaign by killing it out from under the maker.
  it("refuses a cancel from anyone who is not the maker", async () => {
    const c = await openCampaign(7);
    await contribute(c, CONTRIBUTION).then(confirm);

    const stranger = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(stranger.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    // The stranger signs for themselves but passes the maker's fundraiser PDA.
    // Note the explicit account list: passing `fundraiser` from the campaign
    // rather than deriving it from the stranger is what makes this an attack on
    // somebody else's campaign rather than a harmless no-op on their own.
    try {
      await program.methods
        .cancel()
        .accountsPartial({
          maker: stranger.publicKey,
          mintToRaise: c.mint,
          fundraiser: c.fundraiser,
          vault: c.vault,
        })
        .signers([stranger])
        .rpc();
      assert.fail(
        "a stranger must not be able to cancel someone else's campaign",
      );
    } catch (err) {
      // Anchor's seeds constraint catches this first: the PDA is derived from the
      // signer, so a stranger's key derives a different address than the one
      // passed. Either that or our own UnauthorizedMaker is a correct refusal —
      // what matters is that it is refused for an authorization reason and not,
      // say, because the vault happened to be empty.
      const code = errorCodeOf(err).toLowerCase();
      assert.oneOf(
        code,
        ["unauthorizedmaker", "constraintseeds"],
        `expected an authorization failure, got ${errorCodeOf(err)}`,
      );
    }

    // The campaign is untouched: still open, still holding the contribution.
    const state = await program.account.fundraiser.fetch(c.fundraiser);
    assert.isFalse(state.cancelled, "the campaign must not be cancelled");
    assert.strictEqual(
      await vaultBalance(c),
      BigInt(CONTRIBUTION),
      "the contribution must still be in the vault",
    );
  });

  // ── knock-on effects of the flag ─────────────────────────────────────

  it("refuses further contributions once cancelled", async () => {
    const c = await openCampaign(7);
    await contribute(c, CONTRIBUTION).then(confirm);
    await cancel(c).then(confirm);

    try {
      await contribute(c, CONTRIBUTION);
      assert.fail("a cancelled campaign must not accept more contributions");
    } catch (err) {
      assertErrorIs(
        err,
        "FundraiserCancelled",
        "the campaign is cancelled, so it is closed to new money",
      );
    }
  });

  it("refuses a second cancel", async () => {
    const c = await openCampaign(7);
    await cancel(c).then(confirm);

    try {
      await cancel(c);
      assert.fail("cancelling twice must be refused");
    } catch (err) {
      assertErrorIs(
        err,
        "AlreadyCancelled",
        "the campaign is already cancelled",
      );
    }
  });
});
