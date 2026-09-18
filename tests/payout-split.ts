import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  freezeAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert, AssertionError } from "chai";
import NodeWallet from "@anchor-lang/core/dist/cjs/nodewallet";

import { Fundraiser } from "../target/types/fundraiser";

describe("fundraiser — immutable payout split", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;
  const TARGET = 10_000_000n;
  const BASIS_POINTS_DENOMINATOR = 10_000n;

  const confirm = async (signature: string): Promise<string> => {
    const blockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...blockhash });
    return signature;
  };

  const tokenBalance = async (
    address: anchor.web3.PublicKey,
  ): Promise<bigint> => {
    const balance = await provider.connection.getTokenAccountBalance(address);
    return BigInt(balance.value.amount);
  };

  const errorCodeOf = (error: any): string => {
    if (error instanceof AssertionError) throw error;
    if (error?.error?.errorCode?.code) return error.error.errorCode.code;

    const text = `${error?.message ?? ""} ${JSON.stringify(error?.logs ?? [])}`;
    const match = text.match(/Error Code: (\w+)/);
    return match?.[1] ?? text.slice(0, 300);
  };

  const assertErrorIs = (error: any, expected: string) => {
    assert.strictEqual(
      errorCodeOf(error).toLowerCase(),
      expected.toLowerCase(),
    );
  };

  type Campaign = {
    maker: anchor.web3.Keypair;
    beneficiary: anchor.web3.PublicKey;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  /**
   * Creates a campaign and mints directly into its vault. Contribution behavior
   * is covered by the other suites; these tests isolate settlement behavior.
   */
  const createCampaign = async (
    makerFeeBps: number,
    vaultAmount: bigint,
    beneficiary = provider.publicKey,
    maker = anchor.web3.Keypair.generate(),
  ): Promise<Campaign> => {
    await provider.connection
      .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    // The provider is mint and freeze authority only to make test setup simple.
    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6,
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId,
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new anchor.BN(TARGET.toString()), 7, makerFeeBps)
      .accountsPartial({
        maker: maker.publicKey,
        beneficiary,
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

    if (vaultAmount > 0n) {
      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        vault,
        provider.publicKey,
        vaultAmount,
      );
    }

    return { maker, beneficiary, mint, fundraiser, vault };
  };

  const settle = async (
    campaign: Campaign,
    beneficiary = campaign.beneficiary,
    beneficiaryAta = getAssociatedTokenAddressSync(campaign.mint, beneficiary),
  ) => {
    const makerAta = getAssociatedTokenAddressSync(
      campaign.mint,
      campaign.maker.publicKey,
    );
    await program.methods
      .checkContributions()
      .accountsPartial({
        maker: campaign.maker.publicKey,
        beneficiary,
        mintToRaise: campaign.mint,
        fundraiser: campaign.fundraiser,
        vault: campaign.vault,
        makerAta,
        beneficiaryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([campaign.maker])
      .rpc()
      .then(confirm);

    return { makerAta, beneficiaryAta };
  };

  it("pays a 3% maker fee and sends every remaining unit to the beneficiary", async () => {
    // The odd amount proves that integer division rounds only the fee down and
    // that the final remainder still reaches the beneficiary.
    const vaultAmount = 10_000_001n;
    const makerFeeBps = 300n;
    const campaign = await createCampaign(Number(makerFeeBps), vaultAmount);

    const { makerAta, beneficiaryAta } = await settle(campaign);
    const expectedMakerFee =
      (vaultAmount * makerFeeBps) / BASIS_POINTS_DENOMINATOR;

    assert.strictEqual(await tokenBalance(makerAta), expectedMakerFee);
    assert.strictEqual(
      await tokenBalance(beneficiaryAta),
      vaultAmount - expectedMakerFee,
    );
    assert.strictEqual(await tokenBalance(campaign.vault), 0n);
    assert.isNull(
      await provider.connection.getAccountInfo(campaign.fundraiser),
    );
  });

  it("pays the entire vault to the beneficiary when the maker fee is zero", async () => {
    const vaultAmount = 12_345_678n;
    const campaign = await createCampaign(0, vaultAmount);

    const { makerAta, beneficiaryAta } = await settle(campaign);

    assert.strictEqual(await tokenBalance(makerAta), 0n);
    assert.strictEqual(await tokenBalance(beneficiaryAta), vaultAmount);
    assert.strictEqual(await tokenBalance(campaign.vault), 0n);
  });

  it("rejects one unit below the target and settles exactly at the target", async () => {
    const belowTarget = await createCampaign(300, TARGET - 1n);

    try {
      await settle(belowTarget);
      assert.fail("settlement below the target should fail");
    } catch (error) {
      assertErrorIs(error, "TargetNotMet");
    }

    assert.strictEqual(await tokenBalance(belowTarget.vault), TARGET - 1n);
    assert.isNotNull(
      await provider.connection.getAccountInfo(belowTarget.fundraiser),
    );

    const exactTarget = await createCampaign(300, TARGET);
    const { makerAta, beneficiaryAta } = await settle(exactTarget);
    const expectedMakerFee = (TARGET * 300n) / BASIS_POINTS_DENOMINATOR;

    assert.strictEqual(await tokenBalance(makerAta), expectedMakerFee);
    assert.strictEqual(
      await tokenBalance(beneficiaryAta),
      TARGET - expectedMakerFee,
    );
    assert.strictEqual(await tokenBalance(exactTarget.vault), 0n);
    assert.isNull(
      await provider.connection.getAccountInfo(exactTarget.fundraiser),
    );
  });

  it("accepts and stores the maximum 10% maker fee", async () => {
    const campaign = await createCampaign(1_000, TARGET);
    const fundraiserAccount = await program.account.fundraiser.fetch(
      campaign.fundraiser,
    );

    assert.strictEqual(fundraiserAccount.makerFeeBps, 1_000);
    assert.strictEqual(
      fundraiserAccount.beneficiary.toBase58(),
      campaign.beneficiary.toBase58(),
    );

    const { makerAta, beneficiaryAta } = await settle(campaign);
    assert.strictEqual(await tokenBalance(makerAta), TARGET / 10n);
    assert.strictEqual(await tokenBalance(beneficiaryAta), (TARGET * 9n) / 10n);
  });

  it("rejects a beneficiary different from the immutable campaign beneficiary", async () => {
    const vaultAmount = 10_000_000n;
    const campaign = await createCampaign(300, vaultAmount);
    const impostor = anchor.web3.Keypair.generate();

    // The supplied SystemAccount must exist before Anchor can check its address.
    await provider.connection
      .requestAirdrop(impostor.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    try {
      await settle(campaign, impostor.publicKey);
      assert.fail("settlement with a different beneficiary should fail");
    } catch (error) {
      assertErrorIs(error, "InvalidBeneficiary");
    }

    assert.strictEqual(await tokenBalance(campaign.vault), vaultAmount);
    assert.isNotNull(
      await provider.connection.getAccountInfo(campaign.fundraiser),
    );
  });

  it("rejects a forged beneficiary token account", async () => {
    const campaign = await createCampaign(300, TARGET);
    const impostor = anchor.web3.Keypair.generate();
    const impostorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        campaign.mint,
        impostor.publicKey,
      )
    ).address;

    try {
      await settle(campaign, campaign.beneficiary, impostorAta);
      assert.fail("settlement with a forged beneficiary ATA should fail");
    } catch (error) {
      assertErrorIs(error, "ConstraintTokenOwner");
    }

    assert.strictEqual(await tokenBalance(campaign.vault), TARGET);
    assert.isNotNull(
      await provider.connection.getAccountInfo(campaign.fundraiser),
    );
  });

  it("rejects settlement with a mint different from the campaign mint", async () => {
    const campaign = await createCampaign(300, 0n);
    const forgedMint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6,
    );
    const forgedVault = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        forgedMint,
        campaign.fundraiser,
        true,
      )
    ).address;
    await mintTo(
      provider.connection,
      wallet.payer,
      forgedMint,
      forgedVault,
      provider.publicKey,
      TARGET,
    );

    try {
      await program.methods
        .checkContributions()
        .accountsPartial({
          maker: campaign.maker.publicKey,
          beneficiary: campaign.beneficiary,
          mintToRaise: forgedMint,
          fundraiser: campaign.fundraiser,
          vault: forgedVault,
          makerAta: getAssociatedTokenAddressSync(
            forgedMint,
            campaign.maker.publicKey,
          ),
          beneficiaryAta: getAssociatedTokenAddressSync(
            forgedMint,
            campaign.beneficiary,
          ),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([campaign.maker])
        .rpc()
        .then(confirm);
      assert.fail("settlement with a forged mint should fail");
    } catch (error) {
      assertErrorIs(error, "ConstraintHasOne");
    }

    assert.strictEqual(await tokenBalance(campaign.vault), 0n);
    assert.strictEqual(await tokenBalance(forgedVault), TARGET);
    assert.isNotNull(
      await provider.connection.getAccountInfo(campaign.fundraiser),
    );
  });

  it("rejects the maker as the campaign beneficiary", async () => {
    const maker = anchor.web3.Keypair.generate();

    try {
      await createCampaign(300, 0n, maker.publicKey, maker);
      assert.fail("the maker should not be accepted as beneficiary");
    } catch (error) {
      assertErrorIs(error, "InvalidBeneficiary");
    }
  });

  it("rejects a maker fee above the 10% cap", async () => {
    try {
      await createCampaign(1_001, 0n);
      assert.fail("a fee above 1,000 basis points should fail");
    } catch (error) {
      assertErrorIs(error, "InvalidMakerFee");
    }
  });

  it("rolls back the maker payment if the beneficiary transfer fails", async () => {
    const vaultAmount = 10_000_000n;
    const campaign = await createCampaign(300, vaultAmount);
    const makerAta = getAssociatedTokenAddressSync(
      campaign.mint,
      campaign.maker.publicKey,
    );
    const beneficiaryAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        campaign.mint,
        campaign.beneficiary,
      )
    ).address;

    // The second transfer fails because this destination is frozen. Solana must
    // also revert the ATA creation and maker transfer attempted before it.
    await freezeAccount(
      provider.connection,
      wallet.payer,
      beneficiaryAta,
      campaign.mint,
      provider.publicKey,
    );

    try {
      await settle(campaign);
      assert.fail("settlement to a frozen beneficiary account should fail");
    } catch (error) {
      // This is an SPL Token error, so the rejection itself is the assertion.
    }

    assert.strictEqual(await tokenBalance(campaign.vault), vaultAmount);
    assert.isNull(
      await provider.connection.getAccountInfo(makerAta),
      "the maker ATA creation and fee transfer should both roll back",
    );
    assert.isNotNull(
      await provider.connection.getAccountInfo(campaign.fundraiser),
    );
  });
});
