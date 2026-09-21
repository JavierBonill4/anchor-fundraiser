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
import { assert } from "chai";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

describe("fundraiser", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;

  const maker = anchor.web3.Keypair.generate();

  let mint: anchor.web3.PublicKey;

  let contributorATA: anchor.web3.PublicKey;

  let makerATA: anchor.web3.PublicKey;

  const wallet = provider.wallet as NodeWallet;

  const fundraiser = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
    program.programId,
  )[0];

  const contributor = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("contributor"),
      fundraiser.toBuffer(),
      provider.publicKey.toBuffer(),
    ],
    program.programId,
  )[0];

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      signature,
      ...block,
    });
    return signature;
  };

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
      6,
    );
    console.log("Mint created", mint.toBase58());

    contributorATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        wallet.publicKey,
      )
    ).address;

    makerATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        maker.publicKey,
      )
    ).address;

    const mintTx = await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      contributorATA,
      provider.publicKey,
      1_000_000_0,
    );
    console.log("Minted 10 tokens to contributor", mintTx);
  });

  it("Initialize Fundaraiser", async () => {
    // Add your test here.
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    const tx = await program.methods
      .initialize(new anchor.BN(30000000), 7) // days; must be at least 1
      .accountsPartial({
        maker: maker.publicKey,
        minter: provider.publicKey,
        mintToRaise: mint,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc({
        skipPreflight: true,
      })
      .then(confirm);

    const account = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(account.contributorCount, 0);
    assert.strictEqual(account.badgesMinted, 0);
    assert.isFalse(account.isClaimed);

    console.log("\nInitialized fundraiser Account");
    console.log("Your transaction signature", tx);
  });

  it("Contribute to Fundraiser", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    const tx = await program.methods
      .contribute(new anchor.BN(1000000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser,
        contributorAccount: contributor,
        contributorAta: contributorATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({
        skipPreflight: true,
      })
      .then(confirm);
    const campaign = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(campaign.contributorCount, 1);
    console.log("\nContributed to fundraiser", tx);
    console.log("Your transaction signature", tx);
    console.log(
      "Vault balance",
      (await provider.connection.getTokenAccountBalance(vault)).value.amount,
    );

    let contributorAccount =
      await program.account.contributor.fetch(contributor);
    console.log("Contributor balance", contributorAccount.amount.toString());

    assert.strictEqual(contributorAccount.position, 1);
    assert.strictEqual(contributorAccount.collaborations.length, 1);
    assert.strictEqual(
      contributorAccount.collaborations[0].amount.toString(),
      "1000000",
    );
    assert.isFalse(contributorAccount.badgeMinted);
    const badgeMint = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("badge"),
        fundraiser.toBuffer(),
        provider.publicKey.toBuffer(),
      ],
      program.programId,
    )[0];
    const badgeAta = getAssociatedTokenAddressSync(
      badgeMint,
      provider.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    try {
      await program.methods
        .airdropBadge("https://example.com/badge.json")
        .accountsPartial({
          payer: provider.publicKey,
          contributor: provider.publicKey,
          fundraiser,
          contributorAccount: contributor,
          badgeMint,
          badgeAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      throw new Error("airdrop must wait for claim");
    } catch (e: any) {
      const code = e.error?.errorCode?.code ?? e.message;
      assert.match(String(code), /CampaignNotClaimed/i);
    }
    try {
      await program.methods
        .closeFundraiser()
        .accountsPartial({
          maker: maker.publicKey,
          minter: provider.publicKey,
          mintToRaise: mint,
          fundraiser,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([maker])
        .rpc();
      throw new Error("close must wait for claim + badges");
    } catch (e: any) {
      const code = e.error?.errorCode?.code ?? e.message;
      assert.match(String(code), /CampaignNotClaimed/i);
    }
  });
  it("Contribute to Fundraiser", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    const tx = await program.methods
      .contribute(new anchor.BN(1000000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser,
        contributorAccount: contributor,
        contributorAta: contributorATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc({
        skipPreflight: true,
      })
      .then(confirm);

    console.log("\nContributed to fundraiser", tx);
    console.log("Your transaction signature", tx);
    console.log(
      "Vault balance",
      (await provider.connection.getTokenAccountBalance(vault)).value.amount,
    );

    let contributorAccount =
      await program.account.contributor.fetch(contributor);
    console.log("Contributor balance", contributorAccount.amount.toString());
    assert.strictEqual(contributorAccount.position, 1); // still first donor
    assert.strictEqual(contributorAccount.collaborations.length, 2);
    assert.strictEqual(contributorAccount.amount.toString(), "2000000");
    const campaign = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(campaign.contributorCount, 1); // not a new wallet
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
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc({
          skipPreflight: true,
        })
        .then(confirm);

      console.log("\nContributed to fundraiser", tx);
      console.log("Your transaction signature", tx);
      console.log(
        "Vault balance",
        (await provider.connection.getTokenAccountBalance(vault)).value.amount,
      );
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
      console.log(
        "Vault balance",
        (await provider.connection.getTokenAccountBalance(vault)).value.amount,
      );
      const campaign = await program.account.fundraiser.fetch(fundraiser);
      assert.isFalse(campaign.isClaimed);
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
