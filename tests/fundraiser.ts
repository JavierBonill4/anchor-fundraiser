import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo, getMint } from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import test, { it } from "node:test";
import { Test } from "mocha";
import {assert} from "chai";

describe("fundraiser", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;

  const maker = anchor.web3.Keypair.generate(); // generate make Keypair (both private and public key)

  let mint: anchor.web3.PublicKey; // public key

  let contributorATA: anchor.web3.PublicKey; // public key

  let makerATA: anchor.web3.PublicKey; // public key

  const wallet = provider.wallet as NodeWallet;

  const fundraiser = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("fundraiser"), maker.publicKey.toBuffer()], program.programId)[0]; // fundraiser PDA

  const contributor = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("contributor"), fundraiser.toBuffer(), provider.publicKey.toBuffer()], program.programId)[0]; // contributor PDA

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

  it("Initialize Fundraiser", async () => {
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
  });

    it("Initialize creates the reward mint", async () => {
    const [rewardMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward_mint"), fundraiser.toBuffer()],
      program.programId
    );
    const info = await getMint(provider.connection, rewardMint);
    assert.strictEqual(info.decimals, 9); // raise mint is 6, plus the offset of 3
    assert.isTrue(info.mintAuthority!.equals(fundraiser));
    assert.strictEqual(info.supply, 0n);
  });

  
  // it("intialize Fundraiser - less than minimum amount", async() => {
  //   const freshMaker = anchor.web3.Keypair.generate(); // generate make Keypair
    
  //   /* Airdrop Maker some SOL */
  //   const airdrop = await provider.connection.requestAirdrop(freshMaker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
  //   console.log("\nAirdropped 1 SOL to maker", airdrop);

  //   /* Fetch PDA for the fresh fundraiser */
  //   const freshFundraiser = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("fundraiser"), freshMaker.publicKey.toBuffer()], program.programId)[0];

  //   /* More of a token account */
  //   const vault = getAssociatedTokenAddressSync(mint, freshFundraiser, true);

  //   const accounts = {
  //   maker: freshMaker.publicKey,
  //   fundraiser: freshFundraiser,
  //   mintToRaise: mint,
  //   vault,
  //   systemProgram: anchor.web3.SystemProgram.programId,
  //   tokenProgram: TOKEN_PROGRAM_ID,
  //   associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  // };

  // try{
  //   await program.methods
  //     .initialize(new anchor.BN(1000000), 7)
  //     .accountsPartial(accounts)
  //     .signers([freshMaker])
  //     .rpc(); // no skipPreflight, so you get a real parsed error
  //   throw new Error("the initialization should have failed: amount is less than the minimum amount");
  // }catch(error:any){
  //   throw error;
  //   console.log("\ninitialization correctly refused: amount is less than the minimum amount");
  //   console.log(error.error?.errorCode?.code ?? error.message);
  // }
     
  // });

  // it("re-initialize Fundraiser - should fail", async() => {
  //   const freshMaker = anchor.web3.Keypair.generate(); // generate make Keypair
    
  //   /* Airdrop Maker some SOL */
  //   const airdrop = await provider.connection.requestAirdrop(freshMaker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
  //   console.log("\nAirdropped 1 SOL to maker", airdrop);

  //   /* Fetch PDA for the fresh fundraiser */
  //   const freshFundraiser = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("fundraiser"), freshMaker.publicKey.toBuffer()], program.programId)[0];

  //   /* More of a token account */
  //   const vault = getAssociatedTokenAddressSync(mint, freshFundraiser, true);

  //   const accounts = {
  //   maker: freshMaker.publicKey,
  //   fundraiser: freshFundraiser,
  //   mintToRaise: mint,
  //   vault,
  //   systemProgram: anchor.web3.SystemProgram.programId,
  //   tokenProgram: TOKEN_PROGRAM_ID,
  //   associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  // };

  // // First init - should succeed
  // // minimum amount -> 3 * 10e6 (30_000000) because the mint has 6 decimals
  // await program.methods
  //   .initialize(new anchor.BN(30_000000), 7)
  //   .accountsPartial(accounts)
  //   .signers([freshMaker])
  //   .rpc({ skipPreflight: true })
  //   .then(confirm);

  // console.log("\nInitialized fundraiser Account (first time)");


  // // Second init on the same account - should fail
  // try {
  //   await program.methods
  //     .initialize(new anchor.BN(30000000), 7)
  //     .accountsPartial(accounts)
  //     .signers([freshMaker])
  //     .rpc(); // no skipPreflight, so you get a real parsed error
  //   throw new Error("the re-initialization should have failed");
  // } catch (error: any) {
  //   console.log("\nRe-initialization correctly refused");
  //   console.log(error.error?.errorCode?.code ?? error.message);
  //   throw error;
    
  // }
  
  // });

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
    console.log("Vault balance", (await provider.connection.getTokenAccountBalance(vault)).value.amount);

    let contributorAccount = await program.account.contributor.fetch(contributor);
    console.log("Contributor balance", contributorAccount.amount.toString());
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
    console.log("Vault balance", (await provider.connection.getTokenAccountBalance(vault)).value.amount);

    let contributorAccount = await program.account.contributor.fetch(contributor);
    console.log("Contributor balance", contributorAccount.amount.toString());
  });

  it("Contribute mints the reward", async () => {
    const [rewardMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward_mint"), fundraiser.toBuffer()],
      program.programId
    );
    const rewardAta = getAssociatedTokenAddressSync(rewardMint, provider.publicKey);

    const contributed = (await program.account.contributor.fetch(contributor)).amount;
    // 6 decimals -> 9 decimals: the same whole token count is 1000x the raw units
    const expected = contributed.mul(new anchor.BN(1000)).toString();

    const balance = (await provider.connection.getTokenAccountBalance(rewardAta)).value.amount;
    const supply = (await provider.connection.getTokenSupply(rewardMint)).value.amount;
    console.log("\nContributed", contributed.toString(), "Reward balance", balance, "Reward supply", supply);

    if (balance !== expected) throw new Error(`expected reward balance ${expected}, got ${balance}`);
    if (supply !== expected) throw new Error(`expected reward supply ${expected}, got ${supply}`);
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
      console.log("Vault balance", (await provider.connection.getTokenAccountBalance(vault)).value.amount);
    } catch (error:any) {
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
    } catch (error:any) {
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
    } catch (error:any) {
      console.log("\nRefund refused while the fundraiser is still running");
      console.log(error.error?.errorCode?.code ?? error.message);
    }
  });
});
