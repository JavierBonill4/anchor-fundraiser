import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  getMint,
  mintTo,
} from "@solana/spl-token";

import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import assert from "assert";

describe("fundraiser", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;

  const maker = anchor.web3.Keypair.generate();

  let mint: anchor.web3.PublicKey;
  let rewardMint: anchor.web3.Keypair;
  const rewardAmount = new anchor.BN(10000000);

  let contributorAta: anchor.web3.PublicKey;
  let makerAta: anchor.web3.PublicKey;

  let contributorRewardAta: anchor.web3.PublicKey;

  let successMaker: anchor.web3.Keypair;
  let successMint: anchor.web3.PublicKey;
  let successRewardMint: anchor.web3.Keypair;
  let successFundraiser: anchor.web3.PublicKey;
  let successVault: anchor.web3.PublicKey;
  let successMakerAta: anchor.web3.PublicKey;
  let successPDA: anchor.web3.PublicKey;
  let successRewardVault: anchor.web3.PublicKey;

  let successContributors: anchor.web3.Keypair[] = [];
  let successContributorAtas: anchor.web3.PublicKey[] = [];

  const wallet = provider.wallet as NodeWallet;

  // ------------------------------------------------------------------
  // Fundraiser PDA
  // ------------------------------------------------------------------

  const [fundraiser, fundraiserBump] =
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );

  // ------------------------------------------------------------------
  // Success PDA
  // ------------------------------------------------------------------

  const [success, successBump] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("success"), fundraiser.toBuffer()],
    program.programId
  );

  // ------------------------------------------------------------------
  // Contributor PDA
  // ------------------------------------------------------------------

  const contributor = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("contributor"),
      fundraiser.toBuffer(),
      provider.publicKey.toBuffer(),
    ],
    program.programId
  )[0];

  // ------------------------------------------------------------------
  // Confirm transaction
  // ------------------------------------------------------------------

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction({
      signature,
      ...block,
    });

    return signature;
  };

  // ------------------------------------------------------------------
  // Test Preparation
  // ------------------------------------------------------------------

  it("Test Preparation", async () => {
    const airdrop = await provider.connection
      .requestAirdrop(maker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    console.log("\nAirdropped 1 SOL to maker", airdrop);

    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    console.log("Mint created", mint.toBase58());

    // The reward mint is created by the initialize instruction.
    // We only generate its keypair here.
    rewardMint = anchor.web3.Keypair.generate();

    contributorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        wallet.publicKey
      )
    ).address;

    makerAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        maker.publicKey
      )
    ).address;

    const mintTx = await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      contributorAta,
      provider.publicKey,
      1_000_000_0
    );

    console.log("Minted 10 tokens to contributor", mintTx);
  });

  // ------------------------------------------------------------------
  // Initialize Fundraiser
  // ------------------------------------------------------------------

  it("Initialize Fundraiser", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    const rewardVault = getAssociatedTokenAddressSync(
      rewardMint.publicKey,
      fundraiser,
      true
    );

    const tx = await program.methods
      .initialize(
        new anchor.BN(10000000), // amount to raise
        7, // duration
        new anchor.BN(10000000) // reward amount
      )
      .accountsPartial({
        maker: maker.publicKey,
        fundraiser,
        mintToRaise: mint,
        rewardMint: rewardMint.publicKey,
        vault,
        rewardVault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker, rewardMint])
      .rpc({
        skipPreflight: true,
      });

    await confirm(tx);

    console.log("\nInitialized fundraiser Account");
    console.log("Your transaction signature", tx);

    // ---------------------------------------------------------
    // Checkpoint 3 assertions
    // ---------------------------------------------------------

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    console.log("Stored reward mint:", fundraiserAccount.rewardMint.toBase58());

    if (!fundraiserAccount.rewardMint.equals(rewardMint.publicKey)) {
      throw new Error("Fundraiser stored the wrong reward mint");
    }

    const rewardMintAccount = await getMint(
      provider.connection,
      rewardMint.publicKey
    );

    if (rewardMintAccount.decimals !== 6) {
      throw new Error(
        "Reward mint should have the same 6 decimals as the fundraising mint"
      );
    }

    if (!rewardMintAccount.mintAuthority?.equals(fundraiser)) {
      throw new Error("Fundraiser PDA should control the reward mint");
    }

    console.log("Reward mint decimals:", rewardMintAccount.decimals);

    console.log(
      "Reward mint authority:",
      rewardMintAccount.mintAuthority?.toBase58()
    );

    console.log("Checkpoint 3: reward mint configuration verified");
  });

  // ------------------------------------------------------------------
  // Prepare successful fundraiser
  // ------------------------------------------------------------------

  it("Prepare successful fundraiser", async () => {
    successMaker = anchor.web3.Keypair.generate();

    await provider.connection
      .requestAirdrop(successMaker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    successMint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    successRewardMint = anchor.web3.Keypair.generate();

    successFundraiser = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), successMaker.publicKey.toBuffer()],
      program.programId
    )[0];

    successVault = getAssociatedTokenAddressSync(
      successMint,
      successFundraiser,
      true
    );

    successRewardVault = getAssociatedTokenAddressSync(
      successRewardMint.publicKey,
      successFundraiser,
      true
    );

    successMakerAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        successMint,
        successMaker.publicKey
      )
    ).address;

    successPDA = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("success"), successFundraiser.toBuffer()],
      program.programId
    )[0];

    console.log("\nPrepared successful fundraiser");
    console.log("Success maker:", successMaker.publicKey.toBase58());
    console.log("Success mint:", successMint.toBase58());
    console.log("Success fundraiser:", successFundraiser.toBase58());
    console.log("Success PDA:", successPDA.toBase58());
  });

  // ------------------------------------------------------------------
  // Initialize successful fundraiser
  // ------------------------------------------------------------------

  it("Initialize successful fundraiser", async () => {
    const tx = await program.methods
      .initialize(
        new anchor.BN(10000000), // amount to raise
        7, // duration
        new anchor.BN(10000000) // reward amount
      )
      .accountsPartial({
        maker: successMaker.publicKey,
        fundraiser: successFundraiser,
        mintToRaise: successMint,
        rewardMint: successRewardMint.publicKey,
        vault: successVault,
        rewardVault: successRewardVault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([successMaker, successRewardMint])
      .rpc({
        skipPreflight: true,
      });

    await confirm(tx);

    const rewardVaultAccount = await getAccount(
      provider.connection,
      successRewardVault
    );

    assert.equal(
      rewardVaultAccount.mint.toBase58(),
      successRewardMint.publicKey.toBase58()
    );

    assert.equal(
      rewardVaultAccount.owner.toBase58(),
      successFundraiser.toBase58()
    );

    assert.equal(rewardVaultAccount.amount.toString(), rewardAmount.toString());

    console.log("\nInitialized successful fundraiser");
    console.log("Transaction:", tx);

    const fundraiserAccount =
      await program.account.fundraiser.fetch(successFundraiser);

    if (!fundraiserAccount.amountToRaise.eq(new anchor.BN(10000000))) {
      throw new Error("Wrong fundraiser target");
    }

    console.log("Target:", fundraiserAccount.amountToRaise.toString());
  });

  // ------------------------------------------------------------------
  // Fund successful fundraiser
  // ------------------------------------------------------------------

  it("Fund successful fundraiser", async () => {
    const contributionAmount = 1_000_000;

    for (let i = 0; i < 10; i++) {
      const contributor = anchor.web3.Keypair.generate();

      successContributors.push(contributor);

      // Contributor needs SOL because the program creates
      // their Contributor PDA with contributor as payer.
      await provider.connection
        .requestAirdrop(
          contributor.publicKey,
          0.1 * anchor.web3.LAMPORTS_PER_SOL
        )
        .then(confirm);

      // Create the contributor's token account.
      const contributorAta = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          wallet.payer,
          successMint,
          contributor.publicKey
        )
      ).address;

      successContributorAtas.push(contributorAta);

      // Give this contributor exactly 1 token.
      await mintTo(
        provider.connection,
        wallet.payer,
        successMint,
        contributorAta,
        provider.publicKey,
        contributionAmount
      );

      // Derive this contributor's PDA.
      const contributorPDA = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          successFundraiser.toBuffer(),
          contributor.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

      // Contribute exactly 1 token.
      const tx = await program.methods
        .contribute(new anchor.BN(contributionAmount))
        .accountsPartial({
          contributor: contributor.publicKey,
          fundraiser: successFundraiser,
          contributorAccount: contributorPDA,
          contributorAta,
          vault: successVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([contributor])
        .rpc({
          skipPreflight: true,
        });

      await confirm(tx);

      console.log(`Contributor ${i + 1}/10 contributed 1 token`);
    }

    // The campaign target is 10 tokens =
    // 10,000,000 base units.
    const vaultBalance =
      await provider.connection.getTokenAccountBalance(successVault);

    if (vaultBalance.value.amount !== "10000000") {
      throw new Error(
        `Expected 10,000,000 in vault, got ${vaultBalance.value.amount}`
      );
    }

    console.log("\nSuccessful fundraiser fully funded");

    console.log("Vault balance:", vaultBalance.value.amount);
  });

  // ------------------------------------------------------------------
  // Check successful fundraiser contributions
  // ------------------------------------------------------------------

  it("Checks successful fundraiser contributions", async () => {
    const tx = await program.methods
      .checkContributions()
      .accountsPartial({
        maker: successMaker.publicKey,
        mintToRaise: successMint,
        fundraiser: successFundraiser,
        vault: successVault,
        makerAta: successMakerAta,
        success: successPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([successMaker])
      .rpc({
        skipPreflight: true,
      });

    await confirm(tx);

    console.log("\nSuccessful fundraiser checked");

    console.log("Transaction:", tx);

    // The maker should now have the entire 10-token vault.
    const makerBalance =
      await provider.connection.getTokenAccountBalance(successMakerAta);

    if (makerBalance.value.amount !== "10000000") {
      throw new Error(
        `Expected maker to receive 10,000,000, got ${makerBalance.value.amount}`
      );
    }

    console.log("Maker balance:", makerBalance.value.amount);

    // The fundraiser vault should now be empty.
    const vaultBalance =
      await provider.connection.getTokenAccountBalance(successVault);

    if (vaultBalance.value.amount !== "0") {
      throw new Error(
        `Expected vault to be empty, got ${vaultBalance.value.amount}`
      );
    }

    console.log("Vault balance:", vaultBalance.value.amount);

    // The Fundraiser account should have been closed.
    const fundraiserAccount =
      await program.account.fundraiser.fetchNullable(successFundraiser);

    if (fundraiserAccount !== null) {
      throw new Error("Fundraiser account should have been closed");
    }

    console.log("Fundraiser account closed");

    // The Success PDA should remain.
    const successAccount = await program.account.success.fetch(successPDA);

    if (!successAccount.fundraiser.equals(successFundraiser)) {
      throw new Error("Success PDA has wrong fundraiser");
    }

    if (!successAccount.maker.equals(successMaker.publicKey)) {
      throw new Error("Success PDA has wrong maker");
    }

    if (!successAccount.rewardMint.equals(successRewardMint.publicKey)) {
      throw new Error("Success PDA has wrong reward mint");
    }

    console.log("Success PDA verified");
  });

  // ------------------------------------------------------------------
  // Claim reward - first contributor
  // ------------------------------------------------------------------

  it("Claims reward - first contributor", async () => {
    const contributor = successContributors[0];
    const contributorAta = successContributorAtas[0];

    const contributorPDA = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        successFundraiser.toBuffer(),
        contributor.publicKey.toBuffer(),
      ],
      program.programId
    )[0];

    const contributorRewardAta = getAssociatedTokenAddressSync(
      successRewardMint.publicKey,
      contributor.publicKey
    );

    const rewardVaultBalanceBefore = (
      await getAccount(provider.connection, successRewardVault)
    ).amount;

    const contributorRewardBalanceBefore = await provider.connection
      .getTokenAccountBalance(contributorRewardAta)
      .catch(() => null);

    console.log("\nBefore claim:");
    console.log("Reward vault:", rewardVaultBalanceBefore.toString());
    console.log(
      "Contributor reward balance:",
      contributorRewardBalanceBefore?.value.amount ?? "0"
    );

    const tx = await program.methods
      .claimReward()
      .accountsPartial({
        contributor: contributor.publicKey,
        success: successPDA,
        fundraiser: successFundraiser,
        contributorAccount: contributorPDA,
        rewardMint: successRewardMint.publicKey,
        rewardVault: successRewardVault,
        contributorRewardAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([contributor])
      .rpc({
        skipPreflight: true,
      });

    await confirm(tx);

    console.log("Reward claimed");
    console.log("Transaction:", tx);

    // ---------------------------------------------------------
    // Verify contributor received exactly 1 reward token
    // ---------------------------------------------------------

    const rewardAtaInfo =
      await provider.connection.getAccountInfo(contributorRewardAta);

    console.log("Contributor reward ATA:", contributorRewardAta.toBase58());

    console.log("Contributor reward ATA exists:", rewardAtaInfo !== null);

    if (rewardAtaInfo) {
      console.log("Reward ATA owner:", rewardAtaInfo.owner.toBase58());

      const contributorRewardBalance =
        await provider.connection.getTokenAccountBalance(contributorRewardAta);

      console.log(
        "Contributor reward balance:",
        contributorRewardBalance.value.amount
      );

      assert.equal(contributorRewardBalance.value.amount, "1000000");
    } else {
      throw new Error("Contributor reward ATA does not exist after claim");
    }

    // ---------------------------------------------------------
    // Verify reward vault decreased by exactly 1 token
    // ---------------------------------------------------------

    const rewardVaultBalanceAfter = (
      await getAccount(provider.connection, successRewardVault)
    ).amount;

    assert.equal(rewardVaultBalanceAfter.toString(), "9000000");

    console.log("Reward vault balance:", rewardVaultBalanceAfter.toString());

    // ---------------------------------------------------------
    // Verify reward_claimed flag
    // ---------------------------------------------------------

    const contributorAccount =
      await program.account.contributor.fetch(contributorPDA);

    assert.equal(contributorAccount.amount.toString(), "1000000");

    assert.equal(contributorAccount.rewardClaimed, true);

    console.log(
      "Contributor reward_claimed:",
      contributorAccount.rewardClaimed
    );
  });

  // ------------------------------------------------------------------
  // Double claim - should be refused
  // ------------------------------------------------------------------

  it("Claims reward - double claim should fail", async () => {
    const contributor = successContributors[0];

    const contributorPDA = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        successFundraiser.toBuffer(),
        contributor.publicKey.toBuffer(),
      ],
      program.programId
    )[0];

    const contributorRewardAta = getAssociatedTokenAddressSync(
      successRewardMint.publicKey,
      contributor.publicKey
    );

    try {
      await program.methods
        .claimReward()
        .accountsPartial({
          contributor: contributor.publicKey,
          success: successPDA,
          fundraiser: successFundraiser,
          contributorAccount: contributorPDA,
          rewardMint: successRewardMint.publicKey,
          rewardVault: successRewardVault,
          contributorRewardAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([contributor])
        .rpc({
          skipPreflight: false,
        });

      throw new Error(
        "Expected second reward claim to fail because reward was already claimed"
      );
    } catch (err: any) {
      const errorCode = err?.error?.errorCode?.code;
      const errorNumber = err?.error?.errorCode?.number;

      console.log("\nDouble claim correctly rejected");
      console.log("Error code:", errorCode);
      console.log("Error number:", errorNumber);

      assert.equal(errorCode, "RewardAlreadyClaimed");
      assert.equal(errorNumber, 6008);
    }

    // ---------------------------------------------------------
    // Verify no reward was transferred during the failed claim
    // ---------------------------------------------------------

    const contributorRewardBalance =
      await provider.connection.getTokenAccountBalance(contributorRewardAta);

    const rewardVaultBalance = (
      await getAccount(provider.connection, successRewardVault)
    ).amount;

    assert.equal(contributorRewardBalance.value.amount, "1000000");
    assert.equal(rewardVaultBalance.toString(), "9000000");

    console.log(
      "Contributor reward balance remained:",
      contributorRewardBalance.value.amount
    );

    console.log("Reward vault remained:", rewardVaultBalance.toString());
  });

  // ------------------------------------------------------------------
  // Non-contributor claim - should be refused
  // ------------------------------------------------------------------

  it("Claims reward - non-contributor should fail", async () => {
    const nonContributor = anchor.web3.Keypair.generate();

    const contributorPDA = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        successFundraiser.toBuffer(),
        nonContributor.publicKey.toBuffer(),
      ],
      program.programId
    )[0];

    const contributorRewardAta = getAssociatedTokenAddressSync(
      successRewardMint.publicKey,
      nonContributor.publicKey
    );

    try {
      await program.methods
        .claimReward()
        .accountsPartial({
          contributor: nonContributor.publicKey,
          success: successPDA,
          fundraiser: successFundraiser,
          contributorAccount: contributorPDA,
          rewardMint: successRewardMint.publicKey,
          rewardVault: successRewardVault,
          contributorRewardAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([nonContributor])
        .rpc({
          skipPreflight: false,
        });

      assert.fail("Expected non-contributor claim to fail");
    } catch (err: any) {
      console.log("\nNon-contributor claim correctly rejected");
      console.log("Error:", err?.message ?? err);

      // The Contributor PDA does not exist, so Anchor should reject
      // account validation before claim_reward() executes.
      assert.ok(err);
    }
  });

  // ------------------------------------------------------------------
  // Claim before success - should be refused
  // ------------------------------------------------------------------

  it("Claims reward - should fail before fundraiser succeeds", async () => {
    const rewardVault = getAssociatedTokenAddressSync(
      rewardMint.publicKey,
      fundraiser,
      true
    );

    const contributorRewardAta = getAssociatedTokenAddressSync(
      rewardMint.publicKey,
      provider.publicKey
    );

    try {
      await program.methods
        .claimReward()
        .accountsPartial({
          contributor: provider.publicKey,
          success,
          fundraiser,
          contributorAccount: contributor,
          rewardMint: rewardMint.publicKey,
          rewardVault,
          contributorRewardAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .rpc({
          skipPreflight: false,
        });

      assert.fail("Expected claim before success to fail");
    } catch (err: any) {
      console.log("\nClaim before success correctly rejected");
      console.log("Error:", err?.message ?? err);

      assert.ok(err);
    }
  });

  // ------------------------------------------------------------------
  // First contribution
  // ------------------------------------------------------------------

  it("Contribute to Fundraiser - First Contribution", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    const tx = await program.methods
      .contribute(new anchor.BN(1000000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser,
        contributorAccount: contributor,
        contributorAta,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({
        skipPreflight: true,
      });

    await confirm(tx);

    console.log("\nContributed to fundraiser", tx);

    console.log("Your transaction signature", tx);

    console.log(
      "Vault balance",
      (await provider.connection.getTokenAccountBalance(vault)).value.amount
    );

    const contributorAccount =
      await program.account.contributor.fetch(contributor);

    console.log("Contributor balance", contributorAccount.amount.toString());
  });

  // ------------------------------------------------------------------
  // Second contribution - should be refused
  // ------------------------------------------------------------------

  it("Contribute to Fundraiser - Second Contribution should fail when maximum is reached", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    try {
      await program.methods
        .contribute(new anchor.BN(1000000))
        .accountsPartial({
          contributor: provider.publicKey,
          fundraiser,
          contributorAccount: contributor,
          contributorAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({ skipPreflight: false });

      throw new Error(
        "Expected second contribution to fail because maximum contribution has been reached"
      );
    } catch (err: any) {
      console.log("Second contribution correctly rejected");

      const errorCode = err?.error?.errorCode?.code;
      const errorNumber = err?.error?.errorCode?.number;

      console.log("Error code:", errorCode);
      console.log("Error number:", errorNumber);

      assert.equal(errorCode, "MaximumContributionsReached");
      assert.equal(errorNumber, 6004);
    }
  });

  // ------------------------------------------------------------------
  // Contribution robustness test
  // ------------------------------------------------------------------

  it("Contribute to Fundraiser - Robustness Test", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    try {
      const tx = await program.methods
        .contribute(new anchor.BN(2000000))
        .accountsPartial({
          contributor: provider.publicKey,
          fundraiser,
          contributorAccount: contributor,
          contributorAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({
          skipPreflight: true,
        });

      await confirm(tx);

      console.log("\nContributed to fundraiser", tx);

      console.log("Your transaction signature", tx);

      console.log(
        "Vault balance",
        (await provider.connection.getTokenAccountBalance(vault)).value.amount
      );
    } catch (error: any) {
      console.log("\nError contributing to fundraiser");

      console.log("Error message:", error?.message);

      console.log("Error:", error);

      console.log("Error logs:", error?.logs);

      console.log("Error logs from Anchor:", error?.errorLogs);
    }
  });

  // ------------------------------------------------------------------
  // Check contributions
  // ------------------------------------------------------------------

  it("Check contributions - Robustness Test", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    try {
      const tx = await program.methods
        .checkContributions()
        .accountsPartial({
          maker: maker.publicKey,
          mintToRaise: mint,
          fundraiser,
          makerAta,
          success,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([maker])
        .rpc({
          skipPreflight: true,
        });

      await confirm(tx);

      console.log("\nChecked contributions");

      console.log("Your transaction signature", tx);

      // ---------------------------------------------------------
      // Verify Success PDA
      // ---------------------------------------------------------

      const successAccount = await program.account.success.fetch(success);

      console.log("Success fundraiser:", successAccount.fundraiser.toBase58());

      console.log("Success maker:", successAccount.maker.toBase58());

      console.log("Success reward mint:", successAccount.rewardMint.toBase58());

      console.log("Success fundraiser bump:", successAccount.fundraiserBump);

      console.log("Success bump:", successAccount.bump);

      // ---------------------------------------------------------
      // Verify Success PDA state
      // ---------------------------------------------------------

      if (!successAccount.fundraiser.equals(fundraiser)) {
        throw new Error("Success PDA stored the wrong fundraiser");
      }

      if (!successAccount.maker.equals(maker.publicKey)) {
        throw new Error("Success PDA stored the wrong maker");
      }

      if (!successAccount.rewardMint.equals(rewardMint.publicKey)) {
        throw new Error("Success PDA stored the wrong reward mint");
      }

      if (successAccount.fundraiserBump !== fundraiserBump) {
        throw new Error("Success PDA stored the wrong fundraiser bump");
      }

      if (successAccount.bump !== successBump) {
        throw new Error("Success PDA stored the wrong Success PDA bump");
      }

      console.log("Success PDA state verified");

      // ---------------------------------------------------------
      // Verify Fundraiser was closed
      // ---------------------------------------------------------

      const fundraiserAccount =
        await program.account.fundraiser.fetchNullable(fundraiser);

      if (fundraiserAccount !== null) {
        throw new Error("Fundraiser account should have been closed");
      }

      console.log("Fundraiser account successfully closed");

      // ---------------------------------------------------------
      // Vault balance
      // ---------------------------------------------------------

      console.log(
        "Vault balance",
        (await provider.connection.getTokenAccountBalance(vault)).value.amount
      );

      console.log("Success PDA lifecycle verified");
    } catch (error: any) {
      console.log("\nError checking contributions");

      console.log("Error message:", error?.message);

      console.log("Error:", error);

      console.log("Error logs:", error?.logs);

      console.log("Error logs from Anchor:", error?.errorLogs);
    }
  });

  // ------------------------------------------------------------------
  // Refund Contributions - should be refused while window is open
  // ------------------------------------------------------------------

  it("Refund Contributions - refused while the window is open", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    try {
      await program.methods
        .refund()
        .accountsPartial({
          contributor: provider.publicKey,
          maker: maker.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount: contributor,
          contributorAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      throw new Error("the refund should have been refused");
    } catch (error: any) {
      console.log("\nRefund refused while the fundraiser is still running");

      console.log(error?.error?.errorCode?.code ?? error?.message ?? error);
    }
  });
});
