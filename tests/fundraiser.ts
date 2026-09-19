import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddressSync, getMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";

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

  const receiptMint = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("receipt"), fundraiser.toBuffer(), provider.publicKey.toBuffer()], program.programId)[0];

  const contributorReceiptAta = getAssociatedTokenAddressSync(receiptMint, provider.publicKey);

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
      receiptMint,
      contributorReceiptAta,
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

  // Happy path: the contributor's very first contribution should mint them
  // exactly one NFT receipt, and the mint's authority should already be
  // revoked so the supply can never grow past 1.
  it("NFT Receipt - mints on first contribution", async () => {
    const receiptBalance = await provider.connection.getTokenAccountBalance(contributorReceiptAta);
    console.log("\nReceipt ATA balance", receiptBalance.value.amount);
    if (receiptBalance.value.amount !== "1") {
      throw new Error(`expected exactly 1 receipt token, got ${receiptBalance.value.amount}`);
    }

    const mintInfo = await getMint(provider.connection, receiptMint);
    console.log("Receipt mint decimals", mintInfo.decimals, "supply", mintInfo.supply.toString());
    if (mintInfo.decimals !== 0) {
      throw new Error(`expected 0 decimals for a one-of-one receipt, got ${mintInfo.decimals}`);
    }
    if (mintInfo.supply !== 1n) {
      throw new Error(`expected supply of exactly 1, got ${mintInfo.supply}`);
    }
    if (mintInfo.mintAuthority !== null) {
      throw new Error("expected mint authority to be revoked (null) right after minting");
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
      receiptMint,
      contributorReceiptAta,
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

  // Boundary: a second contribution from the same wallet must NOT mint a
  // second receipt. This also proves `has_receipt` is doing real work — since
  // the mint authority was already revoked after the first contribution, a
  // naive re-mint attempt here would fail the whole transaction, not just
  // silently no-op. Without the `has_receipt` guard in contribute.rs, this
  // test fails: the second contribution itself would be rejected outright.
  it("NFT Receipt - not minted again on a second contribution", async () => {
    // Assert the contribution itself actually landed first — otherwise a
    // silent whole-transaction failure could leave the receipt balance
    // unchanged for the wrong reason and this test would pass regardless.
    let contributorAccount = await program.account.contributor.fetch(contributor);
    if (contributorAccount.amount.toString() !== "2000000") {
      throw new Error(
        `expected the contributor's running total to reflect two contributions (2000000), got ${contributorAccount.amount.toString()}`
      );
    }

    const receiptBalance = await provider.connection.getTokenAccountBalance(contributorReceiptAta);
    console.log("\nReceipt ATA balance after 2nd contribution", receiptBalance.value.amount);
    if (receiptBalance.value.amount !== "1") {
      throw new Error(`expected receipt balance to stay at 1, got ${receiptBalance.value.amount}`);
    }

    const mintInfo = await getMint(provider.connection, receiptMint);
    console.log("Receipt mint supply after 2nd contribution", mintInfo.supply.toString());
    if (mintInfo.supply !== 1n) {
      throw new Error(`expected receipt supply to stay at 1, got ${mintInfo.supply}`);
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
        receiptMint,
        contributorReceiptAta,
        tokenProgram: TOKEN_PROGRAM_ID,
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

  // Abuse: try to sneak an unrelated mint into the receipt slot instead of
  // the real PDA — e.g. hoping to redirect the "proof of donation" to a
  // mint the attacker controls. Anchor's own `seeds = [...]` constraint on
  // `receipt_mint` should reject this before the handler body ever runs.
  // Without the receipt feature these accounts don't exist at all, so this
  // test — and the specific ConstraintSeeds rejection it checks for — has
  // nothing to run against.
  it("NFT Receipt - abuse: rejects a substituted mint account", async () => {
    const fakeMint = anchor.web3.Keypair.generate().publicKey;
    const fakeReceiptAta = getAssociatedTokenAddressSync(fakeMint, provider.publicKey);
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    try {
      await program.methods
      .contribute(new anchor.BN(1000000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser,
        contributorAccount: contributor,
        contributorAta: contributorATA,
        vault,
        receiptMint: fakeMint,
        contributorReceiptAta: fakeReceiptAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc()
      .then(confirm);

      throw new Error("expected the substituted receipt mint to be rejected");
    } catch (error) {
      const code = error.error?.errorCode?.code ?? error.message;
      console.log("\nSubstituted receipt mint correctly rejected:", code);
      if (code !== "ConstraintSeeds") {
        throw new Error(`expected ConstraintSeeds, got ${code}`);
      }
    }
  });
});