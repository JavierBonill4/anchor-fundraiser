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
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { assert, AssertionError } from "chai";

/**
 * Comprehensive test suite for the Permissionless Underwriting feature.
 *
 * Uses solana-bankrun for clock manipulation so we can fast-forward past
 * fundraiser deadlines and underwriting windows.
 *
 * Tests the full lifecycle:
 *   ACTIVE -> UNDERWRITING -> UNDERWRITTEN -> SETTLED
 *   ACTIVE -> UNDERWRITING -> FAILED (refund path)
 */
describe("fundraiser — permissionless underwriting (bankrun)", () => {
  const TARGET = 100_000_000;
  const CONTRIBUTION = 7_000_000;
  const DURATION_DAYS = 7;
  const UNDERWRITING_DAYS = 7;
  const DAY = 86_400n;
  const SLOTS_PER_DAY = 216_000n;
  const BPS = 10_000n;
  const BASE_PREMIUM_RATE = 1_000n;
  const CURVE_SLOPE = 500n;

  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Fundraiser>;
  let payer: anchor.web3.Keypair;

  before(async () => {
    context = await startAnchor("", [], []);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);

    const idl = require("../target/idl/fundraiser.json");
    program = new anchor.Program<Fundraiser>(idl, provider);
    payer = context.payer;
  });

  const send = async (
    ixs: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Keypair[] = []
  ) => {
    const tx = new anchor.web3.Transaction();
    const [blockhash] = await context.banksClient.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(...ixs);
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
  };

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

  const assertErrorIs = (err: any, expected: string, why: string) => {
    const actual = errorCodeOf(err);
    assert.strictEqual(
      actual.toLowerCase(),
      expected.toLowerCase(),
      `${why} (expected ${expected}, got ${actual})`
    );
  };

  /** Check if the fundraiser state matches the expected variant name. */
  const assertState = (fundraiser: any, expected: string, msg: string) => {
    const state = fundraiser.state;
    // Anchor 1.x serializes enum variants as objects: { variantName: {} } or { variantName: null }
    // or sometimes as a plain string. Handle all cases.
    if (typeof state === "string") {
      assert.strictEqual(state, expected, msg);
    } else {
      assert.ok(
        state && typeof state === "object" && state[expected] !== undefined,
        `${msg} (state was ${JSON.stringify(state)})`
      );
    }
  };

  const calcClaim = (
    principal: bigint,
    totalUnderwritten: bigint,
    originalShortfall: bigint
  ): bigint => {
    const utilizationBps = (totalUnderwritten * BPS) / originalShortfall;
    const premiumRate = BASE_PREMIUM_RATE + (utilizationBps * CURVE_SLOPE) / BPS;
    return (principal * (BPS + premiumRate)) / BPS;
  };

  const setupCampaign = async (durationDays: number) => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;

    const rent = await context.banksClient.getRent();
    const mintRent = Number(rent.minimumBalance(BigInt(MINT_SIZE)));

    const contributorAta = getAssociatedTokenAddressSync(mint, payer.publicKey);

    await send(
      [
        anchor.web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: maker.publicKey,
          lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
        }),
        anchor.web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports: mintRent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
        createAssociatedTokenAccountInstruction(payer.publicKey, contributorAta, payer.publicKey, mint),
        createMintToInstruction(mint, contributorAta, payer.publicKey, 100 * CONTRIBUTION),
      ],
      [mintKeypair]
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), payer.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await send(
      [
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
          .instruction(),
      ],
      [maker]
    );

    return { maker, mint, fundraiser, vault, contributorAccount, contributorAta };
  };

  type Campaign = Awaited<ReturnType<typeof setupCampaign>>;

  const contribute = async (c: Campaign, amount: number) => {
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), c.fundraiser.toBuffer(), payer.publicKey.toBuffer()],
      program.programId
    );
    return send([
      await program.methods
        .contribute(new anchor.BN(amount))
        .accountsPartial({
          contributor: payer.publicKey,
          mintToRaise: c.mint,
          fundraiser: c.fundraiser,
          contributorAccount,
          contributorAta: c.contributorAta,
          vault: c.vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction(),
    ]);
  };

  const enterUnderwriting = async (c: Campaign) => {
    return send([
      await program.methods
        .enterUnderwriting()
        .accountsPartial({
          fundraiser: c.fundraiser,
        })
        .instruction(),
    ]);
  };

  /**
   * Underwrite the shortfall. Returns the position PDA, underwriter ATA,
   * and the underwriter keypair. AWAITS the transaction.
   */
  const underwriteShortfall = async (
    c: Campaign,
    underwriter: anchor.web3.Keypair,
    amount: number
  ) => {
    const underwriterAta = getAssociatedTokenAddressSync(c.mint, underwriter.publicKey);
    const [underwriterPosition] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("underwriter"), c.fundraiser.toBuffer(), underwriter.publicKey.toBuffer()],
      program.programId
    );

    // Fund the underwriter with SOL for rent and tokens for underwriting
    await send([
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: underwriter.publicKey,
        lamports: 5 * anchor.web3.LAMPORTS_PER_SOL,
      }),
      createAssociatedTokenAccountInstruction(payer.publicKey, underwriterAta, underwriter.publicKey, c.mint),
      createMintToInstruction(c.mint, underwriterAta, payer.publicKey, amount * 10),
    ]);

    // Execute the underwriting instruction — MUST await
    await send([
      await program.methods
        .underwriteShortfall(new anchor.BN(amount))
        .accountsPartial({
          underwriter: underwriter.publicKey,
          mintToRaise: c.mint,
          fundraiser: c.fundraiser,
          underwriterPosition,
          underwriterAta,
          vault: c.vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction(),
    ], [underwriter]);

    return { underwriterPosition, underwriterAta };
  };

  const repayUnderwriters = async (c: Campaign, amount: number) => {
    const makerAta = getAssociatedTokenAddressSync(c.mint, c.maker.publicKey);
    // Fund maker with tokens for repayment
    await send([
      createAssociatedTokenAccountInstruction(payer.publicKey, makerAta, c.maker.publicKey, c.mint),
      createMintToInstruction(c.mint, makerAta, payer.publicKey, amount),
    ]);
    return send([
      await program.methods
        .repayUnderwriters(new anchor.BN(amount))
        .accountsPartial({
          maker: c.maker.publicKey,
          mintToRaise: c.mint,
          fundraiser: c.fundraiser,
          makerAta,
          vault: c.vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ], [c.maker]);
  };

  const claimUnderwriting = async (
    c: Campaign,
    underwriter: anchor.web3.Keypair,
    underwriterPosition: anchor.web3.PublicKey,
    underwriterAta: anchor.web3.PublicKey
  ) => {
    return send([
      await program.methods
        .claimUnderwriting()
        .accountsPartial({
          underwriter: underwriter.publicKey,
          mintToRaise: c.mint,
          fundraiser: c.fundraiser,
          underwriterPosition,
          underwriterAta,
          vault: c.vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
    ], [underwriter]);
  };

  const checkUnderwritingStatus = async (c: Campaign) => {
    return send([
      await program.methods
        .checkUnderwritingStatus()
        .accountsPartial({
          fundraiser: c.fundraiser,
        })
        .instruction(),
    ]);
  };

  // =====================================================================
  // TEST 1: Full happy-path lifecycle
  // =====================================================================
  it("full underwriting lifecycle: contribute -> underwrite -> repay -> claim", async () => {
    const campaign = await setupCampaign(DURATION_DAYS);

    await contribute(campaign, CONTRIBUTION);
    await advanceDays(BigInt(DURATION_DAYS + 1));

    await enterUnderwriting(campaign);
    let fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assertState(fundraiser, "underwriting", "state should be Underwriting");
    assert.strictEqual(fundraiser.originalShortfall.toString(), String(TARGET - CONTRIBUTION));

    const underwriter = anchor.web3.Keypair.generate();
    const { underwriterPosition, underwriterAta } = await underwriteShortfall(
      campaign, underwriter, TARGET - CONTRIBUTION
    );

    fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assertState(fundraiser, "underwritten", "state should be Underwritten");

    const outstandingClaims = Number(fundraiser.totalOutstandingClaims);
    await repayUnderwriters(campaign, outstandingClaims);

    fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assertState(fundraiser, "settled", "state should be Settled");

    const vaultBefore = await tokenBalance(campaign.vault);
    await claimUnderwriting(campaign, underwriter, underwriterPosition, underwriterAta);
    const vaultAfter = await tokenBalance(campaign.vault);

    assert.strictEqual(
      vaultBefore - vaultAfter,
      BigInt(outstandingClaims),
      "vault should decrease by claim amount"
    );
  });

  // =====================================================================
  // TEST 2: Partial underwriting -> expires -> refund
  // =====================================================================
  it("partial underwriting -> deadline expires -> refund available", async () => {
    const campaign = await setupCampaign(DURATION_DAYS);
    await contribute(campaign, CONTRIBUTION);
    await advanceDays(BigInt(DURATION_DAYS + 1));
    await enterUnderwriting(campaign);

    const underwriter = anchor.web3.Keypair.generate();
    const halfShortfall = Math.floor((TARGET - CONTRIBUTION) / 2);
    await underwriteShortfall(campaign, underwriter, halfShortfall);

    let fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assertState(fundraiser, "underwriting", "should still be Underwriting");

    await advanceDays(BigInt(UNDERWRITING_DAYS + 1));
    await checkUnderwritingStatus(campaign);

    fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assertState(fundraiser, "failed", "state should be Failed");

    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), campaign.fundraiser.toBuffer(), payer.publicKey.toBuffer()],
      program.programId
    );
    const vaultBefore = await tokenBalance(campaign.vault);

    await send([
      await program.methods
        .refund()
        .accountsPartial({
          contributor: payer.publicKey,
          maker: campaign.maker.publicKey,
          mintToRaise: campaign.mint,
          fundraiser: campaign.fundraiser,
          contributorAccount,
          contributorAta: campaign.contributorAta,
          vault: campaign.vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction(),
    ]);

    const vaultAfter = await tokenBalance(campaign.vault);
    assert.strictEqual(vaultBefore - vaultAfter, BigInt(CONTRIBUTION), "refund should return original contribution");
  });

  // =====================================================================
  // TEST 3: Bonding curve pricing changes with utilization
  // =====================================================================
  it("bonding curve: premium increases with utilization", async () => {
    const campaign = await setupCampaign(DURATION_DAYS);
    await contribute(campaign, CONTRIBUTION);
    await advanceDays(BigInt(DURATION_DAYS + 1));
    await enterUnderwriting(campaign);

    const shortfall = TARGET - CONTRIBUTION;
    const halfShortfall = Math.floor(shortfall / 2);

    const underwriter1 = anchor.web3.Keypair.generate();
    const result1 = await underwriteShortfall(campaign, underwriter1, halfShortfall);
    const pos1 = await program.account.underwriterPosition.fetch(result1.underwriterPosition);
    const expectedClaim1 = calcClaim(BigInt(halfShortfall), 0n, BigInt(shortfall));

    assert.strictEqual(
      pos1.claimAmount.toString(),
      expectedClaim1.toString(),
      "first underwriter claim should match 0% utilization"
    );

    const underwriter2 = anchor.web3.Keypair.generate();
    const result2 = await underwriteShortfall(campaign, underwriter2, halfShortfall);
    const pos2 = await program.account.underwriterPosition.fetch(result2.underwriterPosition);
    const expectedClaim2 = calcClaim(BigInt(halfShortfall), BigInt(halfShortfall), BigInt(shortfall));

    assert.strictEqual(
      pos2.claimAmount.toString(),
      expectedClaim2.toString(),
      "second underwriter claim should match 50% utilization"
    );

    const premium1 = Number(pos1.claimAmount) - halfShortfall;
    const premium2 = Number(pos2.claimAmount) - halfShortfall;
    assert.ok(premium2 > premium1, `second premium (${premium2}) should be > first premium (${premium1})`);
  });

  // =====================================================================
  // TEST 4: Double claim prevention
  // =====================================================================
  it("cannot claim twice", async () => {
    const campaign = await setupCampaign(DURATION_DAYS);
    await contribute(campaign, CONTRIBUTION);
    await advanceDays(BigInt(DURATION_DAYS + 1));
    await enterUnderwriting(campaign);

    const underwriter = anchor.web3.Keypair.generate();
    const { underwriterPosition, underwriterAta } = await underwriteShortfall(
      campaign, underwriter, TARGET - CONTRIBUTION
    );

    const fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    await repayUnderwriters(campaign, Number(fundraiser.totalOutstandingClaims));

    await claimUnderwriting(campaign, underwriter, underwriterPosition, underwriterAta);

    // Second claim: position account was closed, so any error is acceptable.
    // The key property is that the claim CANNOT succeed.
    try {
      await claimUnderwriting(campaign, underwriter, underwriterPosition, underwriterAta);
      assert.fail("second claim should be rejected");
    } catch (err) {
      // Account closed by first claim -> ConstraintSeeds or similar
      const code = errorCodeOf(err);
      assert.ok(
        code !== "Success",
        `second claim should fail, got: ${code}`
      );
    }
  });

  // =====================================================================
  // TEST 5: Only position owner can claim
  // =====================================================================
  it("only position owner can claim", async () => {
    const campaign = await setupCampaign(DURATION_DAYS);
    await contribute(campaign, CONTRIBUTION);
    await advanceDays(BigInt(DURATION_DAYS + 1));
    await enterUnderwriting(campaign);

    const underwriter = anchor.web3.Keypair.generate();
    const { underwriterPosition, underwriterAta } = await underwriteShortfall(
      campaign, underwriter, TARGET - CONTRIBUTION
    );

    const fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    await repayUnderwriters(campaign, Number(fundraiser.totalOutstandingClaims));

    // Impersonator passes the REAL position PDA but claims to be a different signer.
    // The `has_one = underwriter` constraint or seeds constraint should reject.
    const impersonator = anchor.web3.Keypair.generate();
    await send([
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: impersonator.publicKey,
        lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
      }),
    ]);
    const impersonatorAta = getAssociatedTokenAddressSync(campaign.mint, impersonator.publicKey);
    await send([
      createAssociatedTokenAccountInstruction(payer.publicKey, impersonatorAta, impersonator.publicKey, campaign.mint),
    ]);

    try {
      // Pass the REAL underwriter's position PDA but sign as impersonator
      await send([
        await program.methods
          .claimUnderwriting()
          .accountsPartial({
            underwriter: impersonator.publicKey,
            mintToRaise: campaign.mint,
            fundraiser: campaign.fundraiser,
            underwriterPosition,
            underwriterAta: impersonatorAta,
            vault: campaign.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ], [impersonator]);
      assert.fail("impersonator should not be able to claim");
    } catch (err) {
      // Seeds won't match because position PDA is derived from real underwriter's key
      // but `underwriter` signer is impersonator. Has_one also won't match.
      const code = errorCodeOf(err);
      assert.ok(
        code !== "Success",
        `should fail with constraint error, got: ${code}`
      );
    }
  });

  // =====================================================================
  // TEST 6: Cannot underwrite more than remaining shortfall
  // =====================================================================
  it("cannot over-underwrite", async () => {
    const campaign = await setupCampaign(DURATION_DAYS);
    await contribute(campaign, CONTRIBUTION);
    await advanceDays(BigInt(DURATION_DAYS + 1));
    await enterUnderwriting(campaign);

    const shortfall = TARGET - CONTRIBUTION;

    try {
      await underwriteShortfall(campaign, anchor.web3.Keypair.generate(), shortfall + 1);
      assert.fail("should not allow over-underwriting");
    } catch (err) {
      assertErrorIs(err, "ExceedsRemainingShortfall", "over-underwriting should be rejected");
    }
  });

  // =====================================================================
  // TEST 7: Cannot underwrite before deadline
  // =====================================================================
  it("cannot underwrite before deadline", async () => {
    const campaign = await setupCampaign(DURATION_DAYS);
    await contribute(campaign, CONTRIBUTION);

    try {
      await enterUnderwriting(campaign);
      assert.fail("should not allow underwriting before deadline");
    } catch (err) {
      assertErrorIs(err, "FundraiserNotEnded", "underwriting before deadline should fail");
    }
  });

  // =====================================================================
  // TEST 8: Cannot underwrite after underwriting deadline
  // =====================================================================
  it("cannot underwrite after underwriting deadline", async () => {
    const campaign = await setupCampaign(DURATION_DAYS);
    await contribute(campaign, CONTRIBUTION);
    await advanceDays(BigInt(DURATION_DAYS + 1));
    await enterUnderwriting(campaign);

    await advanceDays(BigInt(UNDERWRITING_DAYS + 1));

    try {
      await underwriteShortfall(campaign, anchor.web3.Keypair.generate(), 1_000_000);
      assert.fail("should not allow underwriting after deadline");
    } catch (err) {
      assertErrorIs(err, "UnderwritingExpired", "underwriting after deadline should fail");
    }
  });

  // =====================================================================
  // TEST 9: Repay with insufficient amount fails
  // =====================================================================
  it("repay with insufficient amount fails", async () => {
    const campaign = await setupCampaign(DURATION_DAYS);
    await contribute(campaign, CONTRIBUTION);
    await advanceDays(BigInt(DURATION_DAYS + 1));
    await enterUnderwriting(campaign);

    await underwriteShortfall(campaign, anchor.web3.Keypair.generate(), TARGET - CONTRIBUTION);

    const fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    const outstanding = Number(fundraiser.totalOutstandingClaims);

    try {
      await repayUnderwriters(campaign, outstanding - 1);
      assert.fail("should reject insufficient repayment");
    } catch (err) {
      assertErrorIs(err, "InsufficientRepayment", "insufficient repayment should be rejected");
    }
  });

  // =====================================================================
  // TEST 10: Contribute fails in non-Active state
  // =====================================================================
  it("cannot contribute after entering underwriting", async () => {
    const campaign = await setupCampaign(DURATION_DAYS);
    await contribute(campaign, CONTRIBUTION);
    await advanceDays(BigInt(DURATION_DAYS + 1));
    await enterUnderwriting(campaign);

    try {
      await contribute(campaign, 1_000_000);
      assert.fail("should not allow contribution in Underwriting state");
    } catch (err) {
      assertErrorIs(err, "FundraiserEnded", "contribution in Underwriting state should fail");
    }
  });

  // =====================================================================
  // TEST 11: check_underwriting_status is no-op when not in Underwriting
  // =====================================================================
  it("check_underwriting_status is a no-op in Active state", async () => {
    const campaign = await setupCampaign(DURATION_DAYS);
    await contribute(campaign, CONTRIBUTION);

    await checkUnderwritingStatus(campaign);

    const fundraiser = await program.account.fundraiser.fetch(campaign.fundraiser);
    assertState(fundraiser, "active", "should remain Active");
  });

  // =====================================================================
  // TEST 12: Vault balance correct after full lifecycle
  // =====================================================================
  it("vault balance correct after full lifecycle", async () => {
    const campaign = await setupCampaign(DURATION_DAYS);
    await contribute(campaign, CONTRIBUTION);

    const vaultAfterContribute = await tokenBalance(campaign.vault);
    assert.strictEqual(vaultAfterContribute, BigInt(CONTRIBUTION), "vault holds contribution");

    await advanceDays(BigInt(DURATION_DAYS + 1));
    await enterUnderwriting(campaign);

    const shortfall = TARGET - CONTRIBUTION;
    await underwriteShortfall(campaign, anchor.web3.Keypair.generate(), shortfall);

    const vaultAfterUnderwrite = await tokenBalance(campaign.vault);
    assert.strictEqual(
      vaultAfterUnderwrite,
      BigInt(CONTRIBUTION + shortfall),
      "vault holds contribution + underwriting"
    );
  });
});
