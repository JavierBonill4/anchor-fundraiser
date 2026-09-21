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
 * Tests for feat/contribution-receipts.
 *
 * Every assertion here is state- or error-based — never "the call returned".
 * Three of them are the ones the assignment asks for:
 *
 *   happy path    — a real contribution produces exactly one badge and the
 *                   ReceiptClaimed event;
 *   boundary      — a contributor at zero (fresh record, amount == 0) gets
 *                   NothingToReceipt; the same contributor one contribution
 *                   later gets the badge. (The trigger is not a numeric mark
 *                   but the record's liveness; zero is its one-below side and
 *                   any whole-token contribution is its at-it side. The 10%
 *                   per-contribution cap makes "crossing two marks" impossible
 *                   by construction here.)
 *   abuse         — claim twice, claim without ever contributing, claim
 *                   against a foreign campaign, redirect the mint.
 *
 * The two refund tests live in tests/receipts-bankrun.ts: they need the clock
 * moved, and only bankrun can do that deterministically.
 */
describe("fundraiser — contribution receipts", () => {
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

  /** Anchor error name for a rejected transaction, however it arrives. */
  const errorCodeOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;
    const text = `${err?.message ?? ""} ${JSON.stringify(err?.logs ?? [])}`;
    const m = text.match(/Error Code: (\w+)/);
    return m ? m[1] : text.slice(0, 300);
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
    rewardMint: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  const derive = (campaign: Campaign, contributor: anchor.web3.PublicKey) => ({
    contributorAccount: anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), campaign.fundraiser.toBuffer(), contributor.toBuffer()],
      program.programId
    )[0],
    receiptAta: getAssociatedTokenAddressSync(campaign.rewardMint, contributor),
  });

  /** A campaign with `durationDays` days left, run by a fresh maker. */
  const openCampaign = async (durationDays: number): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(maker.publicKey, anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    const mint = await createMint(provider.connection, wallet.payer, provider.publicKey, provider.publicKey, 6);

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const [rewardMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward-mint"), fundraiser.toBuffer()],
      program.programId
    );
    const makerReceiptAta = getAssociatedTokenAddressSync(rewardMint, maker.publicKey);
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new anchor.BN(TARGET), durationDays)
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        rewardMint,
        makerReceiptAta,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc()
      .then(confirm);

    return { maker, mint, fundraiser, rewardMint, vault };
  };

  /** Contributor holds `amount` of the campaign mint, ready to contribute. */
  const makeContributor = async (campaign: Campaign, amount: number) => {
    const owner = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(owner.publicKey, anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    const ata = (
      await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, campaign.mint, owner.publicKey)
    ).address;
    if (amount > 0) {
      await mintTo(provider.connection, wallet.payer, campaign.mint, ata, provider.publicKey, amount);
    }
    return { owner, ata };
  };

  const contribute = (c: Campaign, owner: anchor.web3.Keypair, ata: anchor.web3.PublicKey, amount: number) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: owner.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: derive(c, owner.publicKey).contributorAccount,
        contributorAta: ata,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

  const claim = (c: Campaign, payer: anchor.web3.PublicKey, contributor: anchor.web3.PublicKey) => {
    const { contributorAccount, receiptAta } = derive(c, contributor);
    return program.methods
      .claimReceipt()
      .accountsPartial({
        payer,
        contributor,
        maker: c.maker.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        rewardMint: c.rewardMint,
        contributorAccount,
        receiptAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  };

  /** "0" when the account does not exist — an unclaimed badge has no ATA yet. */
  const tokenBalance = async (address: anchor.web3.PublicKey): Promise<string> => {
    const info = await provider.connection.getTokenAccountBalance(address);
    return info.value.amount;
  };

  const tokenBalanceOrZero = async (address: anchor.web3.PublicKey): Promise<string> => {
    const info = await provider.connection.getParsedAccountInfo(address);
    if (!info.value) return "0";
    return (await provider.connection.getTokenAccountBalance(address)).value.amount;
  };

  // ------------------------------------------------------------------
  // Happy path
  // ------------------------------------------------------------------

  it("mints exactly one badge to a real contributor and emits the event", async () => {
    const campaign = await openCampaign(7);
    const { owner, ata } = await makeContributor(campaign, 5 * CONTRIBUTION);

    await contribute(campaign, owner, ata, CONTRIBUTION);

    // Someone else pays for the claim — the feature is permissionless.
    const tx = await claim(campaign, wallet.publicKey, owner.publicKey).then(confirm);

    // State, not return value: the badge exists, is single, and went to the
    // contributor's ATA for the reward mint.
    assert.strictEqual(await tokenBalance(derive(campaign, owner.publicKey).receiptAta), "1", "exactly one badge minted");

    const fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fundraiser.receiptsMinted.toString(), "1", "counter incremented once");
    assert.ok(fundraiser.rewardMint.equals(campaign.rewardMint), "reward_mint stored at init");

    const record = await program.account.contributor.fetch(derive(campaign, owner.publicKey).contributorAccount);
    assert.strictEqual(record.claimed, true, "claimed flag set");
    assert.strictEqual(record.amount.toString(), String(CONTRIBUTION), "contribution untouched by claim");

    // The event fired, and with the right contents.
    const events = await provider.connection.getParsedTransaction(tx, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = events?.meta?.logMessages ?? [];
    const eventLog = logs.find((l) => l.startsWith("Program data: "));
    assert.isDefined(eventLog, "claim should emit a program event");
    const decoded = program.coder.events.decode(eventLog!.slice("Program data: ".length));
    assert.isDefined(decoded, "event should decode against the IDL");
    assert.strictEqual(decoded!.name.toLowerCase(), "receiptclaimed");
    assert.ok(decoded!.data.contributor.equals(owner.publicKey), "event names the contributor");
    assert.ok(decoded!.data.rewardMint.equals(campaign.rewardMint), "event names the reward mint");
    assert.strictEqual(decoded!.data.totalMinted.toString(), "1");

    // The maker got their init-time badge too.
    const makerAta = getAssociatedTokenAddressSync(campaign.rewardMint, campaign.maker.publicKey);
    assert.strictEqual(await tokenBalance(makerAta), "1", "maker's init badge");
  });

  // ------------------------------------------------------------------
  // The boundary: no stake → nothing; stake → badge
  // ------------------------------------------------------------------

  it("gives a never-contributor NothingToReceipt, then the badge once they contribute", async () => {
    const campaign = await openCampaign(7);
    const { owner, ata } = await makeContributor(campaign, 2 * CONTRIBUTION);

    // One below the trigger: a wallet with no contribution record at all.
    // The claim itself must fail with OUR error — not a generic authority or
    // account-uninitialized failure — and it must leave nothing behind.
    try {
      await claim(campaign, wallet.publicKey, owner.publicKey);
      assert.fail("a wallet that never contributed must not receive a badge");
    } catch (err) {
      assertErrorIs(err, "NothingToReceipt", "no contribution record → nothing to receipt");
    }
    const record = await program.account.contributor.fetchNullable(derive(campaign, owner.publicKey).contributorAccount);
    assert.isNull(record, "failed claim must not leave a phantom record");

    // At the trigger: the same wallet contributes a whole token...
    await contribute(campaign, owner, ata, CONTRIBUTION);
    await claim(campaign, wallet.publicKey, owner.publicKey).then(confirm);
    assert.strictEqual(await tokenBalance(derive(campaign, owner.publicKey).receiptAta), "1");
  });

  // ------------------------------------------------------------------
  // Abuse cases
  // ------------------------------------------------------------------

  it("refuses a second claim with ReceiptAlreadyClaimed", async () => {
    const campaign = await openCampaign(7);
    const { owner, ata } = await makeContributor(campaign, 5 * CONTRIBUTION);

    await contribute(campaign, owner, ata, CONTRIBUTION);
    await claim(campaign, wallet.publicKey, owner.publicKey).then(confirm);

    try {
      await claim(campaign, wallet.publicKey, owner.publicKey);
      assert.fail("the second claim must be rejected");
    } catch (err) {
      assertErrorIs(err, "ReceiptAlreadyClaimed", "one badge per contributor per campaign");
    }

    // And nothing changed anywhere.
    assert.strictEqual(await tokenBalance(derive(campaign, owner.publicKey).receiptAta), "1");
    const record = await program.account.contributor.fetch(derive(campaign, owner.publicKey).contributorAccount);
    assert.strictEqual(record.claimed, true);
    const fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(fundraiser.receiptsMinted.toString(), "1");
  });

  it("keeps the receipt destination pinned to the contributor", async () => {
    const campaign = await openCampaign(7);
    const { owner, ata } = await makeContributor(campaign, 5 * CONTRIBUTION);
    const thief = anchor.web3.Keypair.generate();

    await contribute(campaign, owner, ata, CONTRIBUTION);

    // `receipt_ata` is derived from the contributor and the reward mint, so
    // the only way to redirect is to lie about the contributor — and then the
    // seed-derived contributor record does not match the thief's (empty) one.
    try {
      await claim(campaign, wallet.publicKey, thief.publicKey);
      assert.fail("claiming as a non-contributor must fail");
    } catch (err) {
      assertErrorIs(err, "NothingToReceipt", "the thief has no contribution record");
    }
    // The honest contributor's badge ATA was never even created, and the
    // thief's holds nothing: nothing was redirected anywhere.
    assert.strictEqual(await tokenBalanceOrZero(derive(campaign, owner.publicKey).receiptAta), "0");
    assert.strictEqual(await tokenBalanceOrZero(derive(campaign, thief.publicKey).receiptAta), "0");
  });

  it("refuses a claim against a foreign fundraiser PDA", async () => {
    const a = await openCampaign(7);
    const b = await openCampaign(7);
    const { owner, ata } = await makeContributor(a, 5 * CONTRIBUTION);

    await contribute(a, owner, ata, CONTRIBUTION);

    // Point claim_receipt at fundraiser B while passing the contributor
    // record derived from fundraiser A: B's reward mint constraint
    // (has_one = reward_mint) does not hold for A's mint.
    const wrongAccounts = {
      payer: wallet.publicKey,
      contributor: owner.publicKey,
      maker: a.maker.publicKey,
      mintToRaise: a.mint,
      fundraiser: b.fundraiser, // the lie
      rewardMint: a.rewardMint, // the mismatch
      contributorAccount: derive(a, owner.publicKey).contributorAccount,
      receiptAta: derive(a, owner.publicKey).receiptAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    };
    try {
      await program.methods.claimReceipt().accountsPartial(wrongAccounts).rpc();
      assert.fail("claim against a foreign fundraiser must fail");
    } catch (err) {
      // The seeds check fires first — fundraiser B's PDA is not derived from
      // maker A's key — and that is enough: the forgery never reaches the
      // handler, so nothing is minted.
      assertErrorIs(err, "ConstraintSeeds", "fundraiser B is not derived from maker A");
    }
    assert.strictEqual(await tokenBalanceOrZero(derive(a, owner.publicKey).receiptAta), "0");
  });

  // ------------------------------------------------------------------
  // Supply discipline
  // ------------------------------------------------------------------

  it("caps the campaign's badge supply at contributors + maker", async () => {
    const campaign = await openCampaign(7);
    const people = await makeContributor(campaign, 5 * CONTRIBUTION);
    const more = await makeContributor(campaign, 5 * CONTRIBUTION);

    await contribute(campaign, people.owner, people.ata, CONTRIBUTION);
    await contribute(campaign, more.owner, more.ata, 2 * CONTRIBUTION);

    await claim(campaign, wallet.publicKey, people.owner.publicKey);
    await claim(campaign, wallet.publicKey, more.owner.publicKey);

    // Two contributors claimed; the maker holds the init-time unit. The mint's
    // total supply can be nothing else: mint_to is only callable through this
    // program, only with the fundraiser PDA as authority, only in these two
    // instructions.
    const supply = await provider.connection.getTokenSupply(campaign.rewardMint);
    assert.strictEqual(supply.value.amount, "3", "one badge per contributor + the maker's init badge");
  });
});
