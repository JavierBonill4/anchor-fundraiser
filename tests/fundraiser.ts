import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { assert } from "chai";

const REWARD_DECIMALS = 9;

describe("fundraiser", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;

  const maker = anchor.web3.Keypair.generate();

  let mint: anchor.web3.PublicKey;

  let contributorATA: anchor.web3.PublicKey;

  let makerATA: anchor.web3.PublicKey;

  const wallet = provider.wallet as NodeWallet;

  const fundraiser = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("fundraiser"), maker.publicKey.toBuffer()], program.programId)[0];

  const contributor = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("contributor"), fundraiser.toBuffer(), provider.publicKey.toBuffer()], program.programId)[0];

  const rewardMint = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("reward"), fundraiser.toBuffer()], program.programId)[0];

  const contributorRewardATA = getAssociatedTokenAddressSync(rewardMint, provider.publicKey);

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      signature,
      ...block,
    });
    return signature;
  };

  it("Test Preparation", async() => {
    const airdrop = await provider.connection.requestAirdrop(maker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    console.log("\nAirdropped 1 SOL to maker", airdrop);

    mint = await createMint(provider.connection, wallet.payer, provider.publicKey, provider.publicKey, 6);
    console.log("Mint created", mint.toBase58());

    contributorATA = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, mint, wallet.publicKey)).address;

    makerATA = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, mint, maker.publicKey)).address;

    const mintTx = await mintTo(provider.connection, wallet.payer, mint, contributorATA, provider.publicKey, 1_000_000_0);
    console.log("Minted 10 tokens to contributor", mintTx);
  })

  it("Initialize Fundaraiser", async () => {
    // Add your test here.
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    const tx = await program
    .methods
    .initialize(new anchor.BN(30000000), 7)   // days; must be at least 1
    .accountsPartial({
      maker: maker.publicKey,
      fundraiser,
      mintToRaise: mint,
      vault,
      rewardMint,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .signers([maker])
    .rpc({
      skipPreflight: true,
    })
    .then(confirm);

    console.log("\nInitialized fundraiser Account");
    console.log("Your transaction signature", tx);

    const rewardMintAccount = await provider.connection.getParsedAccountInfo(rewardMint);
    const parsed = (rewardMintAccount.value?.data as any).parsed;
    assert.strictEqual(
      parsed.info.decimals,
      REWARD_DECIMALS,
      "the reward mint should be created with REWARD_DECIMALS, independent of mint_to_raise's own decimals"
    );
    assert.strictEqual(
      parsed.info.mintAuthority,
      fundraiser.toBase58(),
      "only the fundraiser PDA should be able to mint reward tokens"
    );
  });

  // The happy path, asserted on actual on-chain state rather than a console.log.
  //
  // mint_to_raise has 6 decimals (see Test Preparation) and the reward mint has
  // REWARD_DECIMALS = 9 (see constants.rs) — deliberately different, so this
  // test only passes if the decimals conversion in `contribute` is actually
  // correct. A naive same-raw-unit mint would produce 1_000_000 reward units
  // here (0.001 reward tokens) instead of the correct 1_000_000_000.
  it("Contribute to Fundraiser — reward is minted with the correct decimals conversion", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    const contributionAmount = 1_000_000; // 1 whole token at 6 decimals

    const tx = await program.methods
    .contribute(new anchor.BN(contributionAmount))
    .accountsPartial({
      contributor: provider.publicKey,
      fundraiser,
      contributorAccount: contributor,
      contributorAta: contributorATA,
      vault,
      rewardMint,
      contributorRewardAta: contributorRewardATA,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc({
      skipPreflight: true,
    })
    .then(confirm);

    console.log("\nContributed to fundraiser", tx);

    const expectedReward = contributionAmount * 10 ** (REWARD_DECIMALS - 6); // = 1_000_000_000

    const rewardBalance = (await provider.connection.getTokenAccountBalance(contributorRewardATA)).value.amount;
    assert.strictEqual(
      rewardBalance,
      expectedReward.toString(),
      `expected ${expectedReward} raw reward units for a ${contributionAmount}-unit contribution, got ${rewardBalance}`
    );

    const contributorAccount = await program.account.contributor.fetch(contributor);
    assert.strictEqual(contributorAccount.amount.toNumber(), contributionAmount);
    assert.strictEqual(
      contributorAccount.rewardAmount.toNumber(),
      expectedReward,
      "the contributor account should track the same reward amount that was minted, for refund to burn later"
    );
  });

  // The boundary: a second, smaller contribution from the same contributor
  // should mint a proportionally smaller reward and accumulate correctly,
  // rather than the conversion only happening to work for round numbers.
  it("Contribute to Fundraiser — a second, smaller contribution mints a proportionally smaller reward", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    const contributionAmount = 1_500_000; // 1.5 whole tokens

    const before = await program.account.contributor.fetch(contributor);
    const rewardBefore = (await provider.connection.getTokenAccountBalance(contributorRewardATA)).value.amount;

    const tx = await program.methods
    .contribute(new anchor.BN(contributionAmount))
    .accountsPartial({
      contributor: provider.publicKey,
      fundraiser,
      contributorAccount: contributor,
      contributorAta: contributorATA,
      vault,
      rewardMint,
      contributorRewardAta: contributorRewardATA,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc({
      skipPreflight: true,
    })
    .then(confirm);

    console.log("\nContributed to fundraiser", tx);

    const expectedNewReward = contributionAmount * 10 ** (REWARD_DECIMALS - 6); // = 1_500_000_000
    const expectedTotalReward = Number(rewardBefore) + expectedNewReward;

    const rewardAfter = (await provider.connection.getTokenAccountBalance(contributorRewardATA)).value.amount;
    assert.strictEqual(rewardAfter, expectedTotalReward.toString());

    const after = await program.account.contributor.fetch(contributor);
    assert.strictEqual(
      after.amount.toNumber(),
      before.amount.toNumber() + contributionAmount
    );
  });

  it("Contribute to Fundraiser - Robustness Test", async () => {
    try {
      const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

      const tx = await program.methods
      .contribute(new anchor.BN(2000000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser,
        contributorAccount: contributor,
        contributorAta: contributorATA,
        vault,
        rewardMint,
        contributorRewardAta: contributorRewardATA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({
        skipPreflight: true,
      })
      .then(confirm);

      console.log("\nContributed to fundraiser", tx);
      console.log("Your transaction signature", tx);
      console.log("Vault balance", (await provider.connection.getTokenAccountBalance(vault)).value.amount);
    } catch (error) {
      console.log("\nError contributing to fundraiser");
      console.log(error.msg);
    }
  });

  it("Check contributions - Robustness Test", async () => {
    try {
      const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

      const tx = await program.methods
      .checkContributions()
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        makerAta: makerATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc({
        skipPreflight: true,
      })
      .then(confirm);

      console.log("\nChecked contributions");
      console.log("Your transaction signature", tx);
      console.log("Vault balance", (await provider.connection.getTokenAccountBalance(vault)).value.amount);
    } catch (error) {
      console.log("\nError checking contributions");
      console.log(error.msg);
    }
  });
  
  // A refund is only legal once the window has closed, so a seven day fundraiser
  // must refuse one on the day it opens. The successful refund is covered in
  // tests/time-window-bankrun.ts, which can move the clock past the deadline.
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
        contributorAta: contributorATA,
        vault,
        rewardMint,
        contributorRewardAta: contributorRewardATA,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
      throw new Error("the refund should have been refused");
    } catch (error) {
      console.log("\nRefund refused while the fundraiser is still running");
      console.log(error.error?.errorCode?.code ?? error.message);
    }
  });
});
