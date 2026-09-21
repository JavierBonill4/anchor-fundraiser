import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { Clock, ProgramTestContext } from "solana-bankrun";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { assert, AssertionError } from "chai";

// Tests for the ownership shares. Bankrun because the refund tests need a
// campaign with contributions in it and then a clock past the deadline.
describe("fundraiser — ownership shares (bankrun)", () => {
  const TARGET = 30_000_000;
  const CONTRIBUTION = 1_000_000;
  const DURATION_DAYS = 7;
  const DAY = 86_400n;
  const SLOTS_PER_DAY = 216_000n; // 400ms slots

  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Fundraiser>;
  let payer: anchor.web3.Keypair;

  before(async () => {
    context = await startAnchor("", [], []);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);

    // Built from the IDL rather than `anchor.workspace`, so this file does not
    // depend on the workspace being resolvable at import time.
    const idl = require("../target/idl/fundraiser.json");
    program = new anchor.Program<Fundraiser>(idl, provider);
    payer = context.payer;
  });

  /** Signs with the payer plus any extras and runs the transaction. */
  const send = async (
    ixs: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Keypair[] = []
  ) => {
    const tx = new anchor.web3.Transaction();
    // Fetch it each time: two identical transactions on the same blockhash are
    // the same transaction, and the bank rejects the second as already processed.
    const [blockhash] = await context.banksClient.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(...ixs);
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
  };

  /**
   * Moves the bank forward by `days`.
   *
   * Warping the slot first is what gives us a new blockhash; setting the clock is
   * what the program actually reads. Both are needed — `warpToSlot` on its own
   * leaves `unix_timestamp` exactly where it was.
   */
  const advanceDays = async (days: bigint) => {
    const before = await context.banksClient.getClock();
    context.warpToSlot(before.slot + days * SLOTS_PER_DAY);

    const clock = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        before.unixTimestamp + days * DAY
      )
    );
  };

  const tokenBalance = async (address: anchor.web3.PublicKey): Promise<bigint> => {
    const account = await context.banksClient.getAccount(address);
    assert.isNotNull(account, "token account should exist");
    return unpackAccount(address, {
      ...account!,
      data: Buffer.from(account!.data),
      owner: new anchor.web3.PublicKey(account!.owner),
    } as any).amount;
  };

  // Supply and mint authority of a mint
  const mintInfo = async (address: anchor.web3.PublicKey) => {
    const account = await context.banksClient.getAccount(address);
    assert.isNotNull(account, "mint should exist");
    const mint = unpackMint(address, {
      ...account!,
      data: Buffer.from(account!.data),
      owner: new anchor.web3.PublicKey(account!.owner),
    } as any);
    return { supply: mint.supply, mintAuthority: mint.mintAuthority };
  };

  /**
   * The Anchor error name for a rejected transaction.
   *
   * `banksClient.processTransaction` throws a plain string rather than an
   * AnchorError, so a raw `custom program error: 0x1776` has to be looked up in
   * the IDL by number. That is the one real ergonomic cost of bankrun.
   */
  const errorCodeOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;

    const text = `${err?.message ?? ""} ${JSON.stringify(err?.logs ?? [])}`;

    const byName = text.match(/Error Code: (\w+)/);
    if (byName) return byName[1];

    const byNumber = text.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (byNumber) {
      const code = parseInt(byNumber[1], 16);
      const known = (program.idl.errors ?? []).find((e: any) => e.code === code);
      if (known) return known.name;
      return `custom error ${code}`;
    }

    return text.slice(0, 300);
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
    shareMint: anchor.web3.PublicKey;
    shareVault: anchor.web3.PublicKey;
  };

  // Fresh mint, fresh maker, open 7 day campaign. Every test gets its own one
  // so they don't step on each other.
  const openCampaign = async (): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;

    const rent = await context.banksClient.getRent();
    const mintRent = Number(rent.minimumBalance(BigInt(MINT_SIZE)));

    await send(
      [
        // The maker pays rent for the fundraiser, the vaults and the share mint.
        // No airdrop in bankrun so the payer funds them.
        anchor.web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: maker.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        }),
        anchor.web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports: mintRent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
      ],
      [mintKeypair]
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const [shareMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("shares"), fundraiser.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    const shareVault = getAssociatedTokenAddressSync(shareMint, fundraiser, true);

    await send(
      [
        await program.methods
          .initialize(new anchor.BN(TARGET), DURATION_DAYS)
          .accountsPartial({
            maker: maker.publicKey,
            mintToRaise: mint,
            fundraiser,
            ownershipMint: shareMint,
            vault,
            ownershipVault: shareVault,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [maker]
    );

    return { maker, mint, fundraiser, vault, shareMint, shareVault };
  };

  // Gives the wallet some SOL for rent and an ATA for the raise mint with `amount` in it
  const fundContributor = async (
    mint: anchor.web3.PublicKey,
    wallet: anchor.web3.Keypair,
    amount: number
  ): Promise<anchor.web3.PublicKey> => {
    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
    const ixs = [
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: wallet.publicKey,
        lamports: anchor.web3.LAMPORTS_PER_SOL,
      }),
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, wallet.publicKey, mint),
    ];
    if (amount > 0) ixs.push(createMintToInstruction(mint, ata, payer.publicKey, amount));
    await send(ixs);
    return ata;
  };

  // The wallet's share ATA for this campaign
  const shareAtaOf = (c: Campaign, wallet: anchor.web3.PublicKey) =>
    getAssociatedTokenAddressSync(c.shareMint, wallet);

  const contributeIx = (c: Campaign, contributor: anchor.web3.Keypair, amount: number) => {
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), c.fundraiser.toBuffer(), contributor.publicKey.toBuffer()],
      program.programId
    );
    return program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        ownershipMint: c.shareMint,
        contributorAccount,
        contributorAta: getAssociatedTokenAddressSync(c.mint, contributor.publicKey),
        vault: c.vault,
        ownershipVault: c.shareVault,
        contributorOwnershipAta: shareAtaOf(c, contributor.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .instruction();
  };

  // The Contributor PDA is optional in refund. Pass it to get the rent back,
  // or null if you never contributed yourself and only hold shares.
  const refundIx = (c: Campaign, contributor: anchor.web3.Keypair, withContributorAccount: boolean) => {
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), c.fundraiser.toBuffer(), contributor.publicKey.toBuffer()],
      program.programId
    );
    return program.methods
      .refund()
      .accountsPartial({
        contributor: contributor.publicKey,
        maker: c.maker.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        ownershipMint: c.shareMint,
        contributorAccount: withContributorAccount ? contributorAccount : null,
        contributorAta: getAssociatedTokenAddressSync(c.mint, contributor.publicKey),
        contributorOwnershipAta: shareAtaOf(c, contributor.publicKey),
        vault: c.vault,
        ownershipVault: c.shareVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
  };

  it("mints the whole share supply into the share vault and revokes the mint authority", async () => {
    const c = await openCampaign();

    const { supply, mintAuthority } = await mintInfo(c.shareMint);
    assert.strictEqual(supply, BigInt(TARGET), "supply should equal the target");
    assert.isNull(mintAuthority, "nobody should be able to mint more shares");

    assert.strictEqual(
      await tokenBalance(c.shareVault),
      BigInt(TARGET),
      "every share should start in the share vault"
    );
    assert.strictEqual(await tokenBalance(c.vault), 0n, "the money vault should start empty");
  });

  it("hands out one share per token contributed", async () => {
    const c = await openCampaign();
    const alice = anchor.web3.Keypair.generate();
    await fundContributor(c.mint, alice, 10 * CONTRIBUTION);

    await send([await contributeIx(c, alice, CONTRIBUTION)], [alice]);

    assert.strictEqual(
      await tokenBalance(shareAtaOf(c, alice.publicKey)),
      BigInt(CONTRIBUTION),
      "alice should hold exactly as many shares as she contributed"
    );
    assert.strictEqual(
      await tokenBalance(c.shareVault),
      BigInt(TARGET - CONTRIBUTION),
      "the share vault should be down by the contribution"
    );

    // shares out == money in, always
    const fundraiser = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(
      BigInt(fundraiser.currentAmount.toString()) + (await tokenBalance(c.shareVault)),
      BigInt(TARGET),
      "current_amount plus shares still in the vault should always equal the target"
    );
  });

  it("refunds whoever holds the shares, not whoever contributed", async () => {
    const c = await openCampaign();
    const alice = anchor.web3.Keypair.generate();
    const bob = anchor.web3.Keypair.generate();
    const aliceAta = await fundContributor(c.mint, alice, 10 * CONTRIBUTION);
    const bobAta = await fundContributor(c.mint, bob, 0);

    await send([await contributeIx(c, alice, CONTRIBUTION)], [alice]);

    // Alice gives all her shares to Bob, who never contributed
    const bobShares = shareAtaOf(c, bob.publicKey);
    await send(
      [
        createAssociatedTokenAccountInstruction(payer.publicKey, bobShares, bob.publicKey, c.shareMint),
        createTransferInstruction(shareAtaOf(c, alice.publicKey), bobShares, alice.publicKey, CONTRIBUTION),
      ],
      [alice]
    );

    // Past the deadline and short of the target, so the campaign failed
    await advanceDays(8n);

    // Alice still has her Contributor PDA but no shares, so nothing for her
    try {
      await send([await refundIx(c, alice, true)], [alice]);
      assert.fail("a refund without shares must be refused");
    } catch (err) {
      assertErrorIs(err, "NoSharesToReturn", "alice gave her claim away");
    }
    assert.strictEqual(
      await tokenBalance(aliceAta),
      BigInt(9 * CONTRIBUTION),
      "alice's money should still be in the vault"
    );

    // Bob has no Contributor PDA so he passes null
    await send([await refundIx(c, bob, false)], [bob]);

    assert.strictEqual(
      await tokenBalance(bobAta),
      BigInt(CONTRIBUTION),
      "bob should be paid one token per share he handed back"
    );
  });

  it("burns the supply and closes the campaign on the last refund", async () => {
    const c = await openCampaign();
    const alice = anchor.web3.Keypair.generate();
    const aliceAta = await fundContributor(c.mint, alice, 10 * CONTRIBUTION);

    await send([await contributeIx(c, alice, CONTRIBUTION)], [alice]);
    await advanceDays(8n);

    const makerBefore = await context.banksClient.getBalance(c.maker.publicKey);
    await send([await refundIx(c, alice, true)], [alice]);

    assert.strictEqual(
      await tokenBalance(aliceAta),
      BigInt(10 * CONTRIBUTION),
      "alice should have every token back"
    );
    assert.isNull(await context.banksClient.getAccount(c.fundraiser), "fundraiser should be closed");
    assert.isNull(await context.banksClient.getAccount(c.vault), "money vault should be closed");
    assert.isNull(await context.banksClient.getAccount(c.shareVault), "share vault should be closed");
    assert.strictEqual((await mintInfo(c.shareMint)).supply, 0n, "every share should be burned");

    const makerAfter = await context.banksClient.getBalance(c.maker.publicKey);
    assert.isAbove(Number(makerAfter - makerBefore), 0, "the maker should get the rent back");

    // The fundraiser account is gone so Anchor rejects this before our code runs.
    // 3012 is AccountNotInitialized. It's an Anchor error, not one from our IDL,
    // so the helper only sees the number.
    try {
      await send([await refundIx(c, alice, false)], [alice]);
      assert.fail("a refund after teardown must be refused");
    } catch (err) {
      assertErrorIs(err, "custom error 3012", "the fundraiser is gone");
    }
  });

  it("stops accepting contributions once every share is handed out", async () => {
    const c = await openCampaign();
    const maxPerWallet = TARGET / 10; // the 10% cap

    // Ten wallets at the cap fill the campaign exactly
    for (let i = 0; i < 10; i++) {
      const wallet = anchor.web3.Keypair.generate();
      await fundContributor(c.mint, wallet, maxPerWallet);
      await send([await contributeIx(c, wallet, maxPerWallet)], [wallet]);
    }
    assert.strictEqual(await tokenBalance(c.shareVault), 0n, "the share vault should be empty");
    assert.strictEqual(await tokenBalance(c.vault), BigInt(TARGET), "the vault should sit exactly at the target");

    // One more token has no share to go with it. The money transfer works, the
    // share transfer fails, whole thing rolls back. The error is the token
    // program's InsufficientFunds (1), not one of ours.
    const late = anchor.web3.Keypair.generate();
    const lateAta = await fundContributor(c.mint, late, CONTRIBUTION);
    try {
      await send([await contributeIx(c, late, CONTRIBUTION)], [late]);
      assert.fail("a contribution past the target must be refused");
    } catch (err) {
      assertErrorIs(err, "custom error 1", "the share vault is empty");
    }
    assert.strictEqual(await tokenBalance(lateAta), BigInt(CONTRIBUTION), "nothing should have left the late wallet");
  });

  it("still refunds when dust was sent straight to the vault", async () => {
    const c = await openCampaign();
    const alice = anchor.web3.Keypair.generate();
    const aliceAta = await fundContributor(c.mint, alice, 10 * CONTRIBUTION);

    await send([await contributeIx(c, alice, CONTRIBUTION)], [alice]);

    // Someone drops one raw unit straight into the vault, bypassing contribute
    await send([createMintToInstruction(c.mint, c.vault, payer.publicKey, 1)]);

    await advanceDays(8n);

    // Last refund, but the vault won't be empty afterwards. The teardown has to
    // skip instead of failing the whole transaction.
    await send([await refundIx(c, alice, true)], [alice]);

    assert.strictEqual(
      await tokenBalance(aliceAta),
      BigInt(10 * CONTRIBUTION),
      "alice should have every token back"
    );
    assert.isNotNull(await context.banksClient.getAccount(c.fundraiser), "fundraiser should stay open");
    assert.strictEqual(await tokenBalance(c.vault), 1n, "only the dust should be left in the vault");
  });
});
