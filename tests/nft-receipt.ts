import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { assert } from "chai";

describe("nft-receipt", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const maker = anchor.web3.Keypair.generate();
  const contributor2 = anchor.web3.Keypair.generate();

  let mint: anchor.web3.PublicKey;
  let contributorATA: anchor.web3.PublicKey;
  let contributor2ATA: anchor.web3.PublicKey;

  const fundraiser = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
    program.programId
  )[0];

  const contributorPDA = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("contributor"), fundraiser.toBuffer(), provider.publicKey.toBuffer()],
    program.programId
  )[0];

  const contributor2PDA = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("contributor"), fundraiser.toBuffer(), contributor2.publicKey.toBuffer()],
    program.programId
  )[0];

  const receiptMint1 = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), fundraiser.toBuffer(), provider.publicKey.toBuffer()],
    program.programId
  )[0];

  const receiptMint2 = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), fundraiser.toBuffer(), contributor2.publicKey.toBuffer()],
    program.programId
  )[0];

  const confirm = async (sig: string) => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...block });
    return sig;
  };

  it("Setup: fund accounts and create campaign", async () => {
    await provider.connection
      .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    await provider.connection
      .requestAirdrop(contributor2.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    contributorATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        wallet.publicKey
      )
    ).address;

    contributor2ATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        contributor2.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      contributorATA,
      provider.publicKey,
      10_000_000
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      contributor2ATA,
      provider.publicKey,
      10_000_000
    );

    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new anchor.BN(30_000_000), 7)
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
      .rpc({ skipPreflight: true })
      .then(confirm);
  });

  it("Test 1: First contribution mints exactly 1 NFT Receipt", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    const contributorReceiptATA = getAssociatedTokenAddressSync(
      receiptMint1,
      provider.publicKey,
      false
    );

    await program.methods
      .contribute(new anchor.BN(1_000_000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser,
        contributorAccount: contributorPDA,
        contributorAta: contributorATA,
        vault,
        receiptMint: receiptMint1,
        contributorReceiptAta: contributorReceiptATA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true })
      .then(confirm);

    const mintInfo = await getMint(provider.connection, receiptMint1);
    assert.strictEqual(mintInfo.supply, 1n, "NFT supply should be exactly 1");
    assert.strictEqual(
      mintInfo.mintAuthority?.toBase58(),
      fundraiser.toBase58(),
      "Mint authority should be fundraiser PDA"
    );

    const ataInfo = await getAccount(provider.connection, contributorReceiptATA);
    assert.strictEqual(ataInfo.amount, 1n, "Contributor should hold 1 NFT");

    const contributorAcc = await program.account.contributor.fetch(contributorPDA);
    assert.isTrue(contributorAcc.receiptMinted, "receipt_minted flag should be true");
  });

  it("Test 2: Second contribution from same contributor does NOT mint another NFT", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    const contributorReceiptATA = getAssociatedTokenAddressSync(
      receiptMint1,
      provider.publicKey,
      false
    );

    await program.methods
      .contribute(new anchor.BN(1_000_000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser,
        contributorAccount: contributorPDA,
        contributorAta: contributorATA,
        vault,
        receiptMint: receiptMint1,
        contributorReceiptAta: contributorReceiptATA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true })
      .then(confirm);

    const mintInfo = await getMint(provider.connection, receiptMint1);
    assert.strictEqual(
      mintInfo.supply,
      1n,
      "NFT supply must still be 1 after second contribution — no double mint"
    );

    const contributorAcc = await program.account.contributor.fetch(contributorPDA);
    assert.isTrue(contributorAcc.receiptMinted, "receipt_minted flag should remain true");
  });

  it("Test 3: Different contributor gets their own separate NFT Receipt", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    const contributor2ReceiptATA = getAssociatedTokenAddressSync(
      receiptMint2,
      contributor2.publicKey,
      false
    );

    await program.methods
      .contribute(new anchor.BN(1_000_000))
      .accountsPartial({
        contributor: contributor2.publicKey,
        fundraiser,
        contributorAccount: contributor2PDA,
        contributorAta: contributor2ATA,
        vault,
        receiptMint: receiptMint2,
        contributorReceiptAta: contributor2ReceiptATA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([contributor2])
      .rpc({ skipPreflight: true })
      .then(confirm);

    assert.notStrictEqual(
      receiptMint1.toBase58(),
      receiptMint2.toBase58(),
      "Each contributor must have a unique receipt mint"
    );

    const mintInfo2 = await getMint(provider.connection, receiptMint2);
    assert.strictEqual(mintInfo2.supply, 1n, "Contributor 2 NFT supply should be 1");
    assert.strictEqual(
      mintInfo2.mintAuthority?.toBase58(),
      fundraiser.toBase58(),
      "Mint authority for contributor 2 should be fundraiser PDA"
    );

    const ata2Info = await getAccount(provider.connection, contributor2ReceiptATA);
    assert.strictEqual(ata2Info.amount, 1n, "Contributor 2 should hold 1 NFT");

    const mintInfo1 = await getMint(provider.connection, receiptMint1);
    assert.strictEqual(
      mintInfo1.supply,
      1n,
      "Contributor 1 NFT supply must still be 1 — not affected by contributor 2"
    );
  });
});
