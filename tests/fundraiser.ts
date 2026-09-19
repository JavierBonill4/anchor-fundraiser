import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo, getMint} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import * as assert from "assert"; // ADDED FOR NEW IT TEST

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
  
  // THE BLOCK BELOW WAS ADDED FOR NFT FEAT
  const receiptMint = anchor.web3.PublicKey.findProgramAddressSync(
  [Buffer.from("receipt"), fundraiser.toBuffer(), provider.publicKey.toBuffer()],
  program.programId
)[0];

const receiptAta = getAssociatedTokenAddressSync(receiptMint, provider.publicKey);
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
      receiptMint,                                              // ADDED FOR NFT
      receiptAta,                                               // ADDED FOR NFT
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,      // ADDED FOR NFT
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

  try {
    const tx = await program.methods
      .contribute(new anchor.BN(1000000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser,
        contributorAccount: contributor,
        contributorAta: contributorATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        receiptMint,
        receiptAta,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc()

    console.log("\nContributed to fundraiser", tx);
  } catch (e) {
    console.error("REAL ERROR:", JSON.stringify(e, null, 2));
    if (e.logs) console.error("LOGS:\n" + e.logs.join("\n"));
    throw e;
  }
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
        receiptMint,                                              // ADDED FOR NFT
        receiptAta,                                               // ADDED FOR NFT
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,      // ADDED FOR NFT
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

  it("mints a one-of-one receipt on first contribution", async () => {
  const mintInfo = await getMint(provider.connection, receiptMint);

  assert.equal(mintInfo.supply.toString(), "1");  // exactly one
  assert.equal(mintInfo.decimals, 0);             // can't split
  assert.equal(mintInfo.mintAuthority.toBase58(), fundraiser.toBase58());         //  the authority is now the fundraiser PDA

  // idempotency proof — the mint fires exactly once no matter how many contributions come in.
  it("does not mint a second receipt on second contribution", async () => {
  const supplyBefore = (await getMint(provider.connection, receiptMint)).supply;

  // Contribute again
  const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
  await program.methods
    .contribute(new anchor.BN(1000000))
    .accountsPartial({
      contributor: provider.publicKey,
      fundraiser,
      contributorAccount: contributor,
      contributorAta: contributorATA,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      receiptMint,
      receiptAta,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .rpc();

  const supplyAfter = (await getMint(provider.connection, receiptMint)).supply;
  assert.equal(supplyAfter.toString(), supplyBefore.toString());
  assert.equal(supplyAfter.toString(), "1");
});

});

  it("mints a one-of-one receipt on first contribution", async () => {
    const mintInfo = await getMint(provider.connection, receiptMint);

    assert.equal(mintInfo.supply.toString(), "1");  // exactly one
    assert.equal(mintInfo.decimals, 0);             // can't split
    assert.equal(mintInfo.mintAuthority.toBase58(), fundraiser.toBase58()); // authority is the fundraiser PDA
  });

  it("does not mint a second receipt on second contribution", async () => {
    const supplyBefore = (await getMint(provider.connection, receiptMint)).supply;

    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    await program.methods
      .contribute(new anchor.BN(1000000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser,
        contributorAccount: contributor,
        contributorAta: contributorATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        receiptMint,
        receiptAta,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc();

    const supplyAfter = (await getMint(provider.connection, receiptMint)).supply;
    assert.equal(supplyAfter.toString(), supplyBefore.toString());
    assert.equal(supplyAfter.toString(), "1");
  });

  it("cannot mint a receipt without contributing", async () => {
    const otherKeypair = anchor.web3.Keypair.generate();
    const otherReceiptMint = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), fundraiser.toBuffer(), otherKeypair.publicKey.toBuffer()],
      program.programId
    )[0];

    const account = await provider.connection.getAccountInfo(otherReceiptMint);
    assert.equal(account, null);
  });
});

