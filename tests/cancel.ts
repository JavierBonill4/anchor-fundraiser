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
 * The feature: a maker can cancel their own campaign.
 *
 * Without it, a fundraiser that has obviously failed still holds everybody's
 * tokens until its duration runs out — and duration is a u8 of days, so that
 * can be most of a year. `cancel_fundraiser` flips `cancelled` on the
 * fundraiser account, which shuts contributions and opens refunds at once.
 *
 * Three things are worth pinning, and they are the three tests below plus two
 * that guard the edges:
 *
 *   happy path  the maker cancels, and the flag is actually on the account
 *   boundary    a contribution to a cancelled campaign is refused
 *   abuse       a stranger cannot cancel somebody else's campaign
 *
 * No clock manipulation is needed for any of them: cancellation is what makes
 * the end of a campaign reachable without waiting.
 */
describe("fundraiser — cancelling a campaign", () => {
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

  /** Anchor error code for a rejected transaction, however the error arrives. */
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
    contributorAccount: anchor.web3.PublicKey;
    contributorAta: anchor.web3.PublicKey;
  };

  /** A fresh maker, mint and open campaign, so each test stands alone. */
  const openCampaign = async (durationDays = 7): Promise<Campaign> => {
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

  const contribute = (c: Campaign, amount = CONTRIBUTION) =>
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

  const cancel = (c: Campaign, authority?: anchor.web3.Keypair) => {
    const signer = authority ?? c.maker;
    return program.methods
      .cancelFundraiser()
      .accountsPartial({
        authority: signer.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        vault: c.vault,
      })
      .signers([signer])
      .rpc();
  };

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
  // happy path
  // ------------------------------------------------------------------

  it("lets the maker cancel an open campaign", async () => {
    const campaign = await openCampaign();

    // Not cancelled to begin with — otherwise the assertion below proves
    // nothing about the instruction.
    const before = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.isFalse(before.cancelled, "a fresh campaign must not be cancelled");

    try {
      await cancel(campaign).then(confirm);
    } catch (err) {
      assert.fail(`the maker must be able to cancel, but got ${errorCodeOf(err)}`);
    }

    const after = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.isTrue(after.cancelled, "cancelled should be set on the account");
  });

  // ------------------------------------------------------------------
  // boundary
  // ------------------------------------------------------------------

  it("refuses a contribution to a cancelled campaign", async () => {
    const campaign = await openCampaign();
    await cancel(campaign).then(confirm);

    try {
      await contribute(campaign);
      assert.fail("a contribution to a cancelled campaign must be refused");
    } catch (err) {
      assertErrorIs(err, "FundraiserCancelled",
        "the contribution should be refused because the campaign was cancelled");
    }

    const vault = await provider.connection.getTokenAccountBalance(campaign.vault);
    assert.strictEqual(vault.value.amount, "0", "nothing should have reached the vault");
  });

  it("opens refunds immediately, without waiting for the deadline", async () => {
    const campaign = await openCampaign(7);

    // Setup, not the assertion: there has to be something to refund.
    try {
      await contribute(campaign);
    } catch (err) {
      assert.fail(`could not set up this test: contribution rejected with ${errorCodeOf(err)}`);
    }

    const held = await provider.connection.getTokenAccountBalance(campaign.contributorAta);

    await cancel(campaign).then(confirm);

    try {
      await refund(campaign).then(confirm);
    } catch (err) {
      assert.fail(
        `a refund from a cancelled campaign must be allowed on day 0, ` +
          `but it was rejected with ${errorCodeOf(err)}`
      );
    }

    const vault = await provider.connection.getTokenAccountBalance(campaign.vault);
    assert.strictEqual(vault.value.amount, "0", "the vault should be empty");

    const back = await provider.connection.getTokenAccountBalance(campaign.contributorAta);
    assert.strictEqual(
      Number(back.value.amount) - Number(held.value.amount),
      CONTRIBUTION,
      "the contributor should have the whole contribution back"
    );
  });

  // ------------------------------------------------------------------
  // abuse
  // ------------------------------------------------------------------

  it("refuses a cancellation from anyone but the maker", async () => {
    const campaign = await openCampaign();

    const stranger = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(stranger.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    try {
      await cancel(campaign, stranger);
      assert.fail("a stranger must not be able to cancel someone else's campaign");
    } catch (err) {
      assertErrorIs(err, "UnauthorizedMaker",
        "the cancellation should be refused because the signer is not the maker");
    }

    const after = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.isFalse(after.cancelled, "the campaign must still be running");
  });

  it("refuses a second cancellation", async () => {
    const campaign = await openCampaign();
    await cancel(campaign).then(confirm);

    try {
      await cancel(campaign);
      assert.fail("cancelling twice must be refused");
    } catch (err) {
      assertErrorIs(err, "AlreadyCancelled",
        "the second cancellation should be refused");
    }
  });
});
