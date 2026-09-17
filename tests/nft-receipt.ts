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

describe("nft receipt", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;
  const maker = anchor.web3.Keypair.generate();

  const fundraiser = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
    program.programId
  )[0];
  const contributorAccount = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("contributor"), fundraiser.toBuffer(), provider.publicKey.toBuffer()],
    program.programId
  )[0];
  const receiptMint = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), fundraiser.toBuffer(), provider.publicKey.toBuffer()],
    program.programId
  )[0];

  let mint: anchor.web3.PublicKey;
  let contributorATA: anchor.web3.PublicKey;
  const receiptAta = () => getAssociatedTokenAddressSync(receiptMint, provider.publicKey);

  const confirm = async (signature: string) => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  it("mints a 0-decimal receipt NFT on the first contribution", async () => {
    const airdrop = await provider.connection
      .requestAirdrop(maker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);
    console.log("airdrop", airdrop);

    mint = await createMint(provider.connection, wallet.payer, provider.publicKey, provider.publicKey, 6);
    contributorATA = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, mint, wallet.publicKey)).address;
    await mintTo(provider.connection, wallet.payer, mint, contributorATA, provider.publicKey, 10_000_000);

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

    await program.methods
      .contribute(new anchor.BN(1_000_000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser,
        contributorAccount,
        contributorAta: contributorATA,
        vault,
        receiptMint,
        receiptAta: receiptAta(),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true })
      .then(confirm);

    const minted = await getMint(provider.connection, receiptMint);
    assert.equal(minted.decimals, 0);
    assert.equal(minted.supply.toString(), "1");

    const ata = await getAccount(provider.connection, receiptAta());
    assert.equal(ata.amount.toString(), "1");

    const state = await program.account.contributor.fetch(contributorAccount);
    assert.equal(state.receiptMinted, true);
    console.log("receipt mint", receiptMint.toBase58());
  });

  it("does not mint a second NFT on a later contribution", async () => {
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    await program.methods
      .contribute(new anchor.BN(1_000_000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser,
        contributorAccount,
        contributorAta: contributorATA,
        vault,
        receiptMint,
        receiptAta: receiptAta(),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .rpc({ skipPreflight: true })
      .then(confirm);

    const minted = await getMint(provider.connection, receiptMint);
    assert.equal(minted.supply.toString(), "1");
    const ata = await getAccount(provider.connection, receiptAta());
    assert.equal(ata.amount.toString(), "1");
  });
});
