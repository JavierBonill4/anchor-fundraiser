import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";

describe("matching pool", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as anchor.Wallet;

  async function campaign(matchAmount: number) {
    const maker = anchor.web3.Keypair.generate();
    const sig = await provider.connection.requestAirdrop(maker.publicKey, 2e9);
    await provider.connection.confirmTransaction(sig);
    const mint = await createMint(provider.connection, wallet.payer, wallet.publicKey, null, 6);
    const makerAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, wallet.payer, mint, maker.publicKey
    );
    const contributorAta = await getOrCreateAssociatedTokenAccount(
      provider.connection, wallet.payer, mint, provider.publicKey
    );
    await mintTo(provider.connection, wallet.payer, mint, makerAta.address, wallet.publicKey, 5_000_000);
    await mintTo(provider.connection, wallet.payer, mint, contributorAta.address, wallet.publicKey, 5_000_000);
    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const [contributor] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), provider.publicKey.toBuffer()],
      program.programId
    );
    const [matchVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("match"), fundraiser.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    await program.methods
      .initialize(new anchor.BN(30_000_000), 7)
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc();
    if (matchAmount > 0) {
      await program.methods
        .depositMatch(new anchor.BN(matchAmount))
        .accountsPartial({
          maker: maker.publicKey,
          mintToRaise: mint,
          fundraiser,
          matchVault,
          makerAta: makerAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([maker])
        .rpc();
      const deposited = await program.account.fundraiser.fetch(fundraiser);
      if (deposited.matchRemaining.toNumber() !== matchAmount) {
        throw new Error("deposit saved " + deposited.matchRemaining.toNumber());
      }
    }
    return { maker, mint, fundraiser, contributor, contributorAta, vault, matchVault };
  }

  it("matches the contribution one for one", async () => {
    const c = await campaign(2_000_000);
    await program.methods
      .contribute(new anchor.BN(1_000_000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser: c.fundraiser,
        contributorAccount: c.contributor,
        contributorAta: c.contributorAta.address,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([{ pubkey: c.matchVault, isWritable: true, isSigner: false }])
      .rpc();
    const state = await program.account.fundraiser.fetch(c.fundraiser);
    assert.equal(state.currentAmount.toNumber(), 2_000_000);
    assert.equal(state.matchRemaining.toNumber(), 1_000_000);
  });

  it("matches only what is left in the pool", async () => {
    const c = await campaign(500_000);
    await program.methods
      .contribute(new anchor.BN(1_000_000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser: c.fundraiser,
        contributorAccount: c.contributor,
        contributorAta: c.contributorAta.address,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([{ pubkey: c.matchVault, isWritable: true, isSigner: false }])
      .rpc();
    const state = await program.account.fundraiser.fetch(c.fundraiser);
    assert.equal(state.currentAmount.toNumber(), 1_500_000);
    assert.equal(state.matchRemaining.toNumber(), 0);
  });

  it("accepts a contribution when no match was deposited", async () => {
    const c = await campaign(0);
    await program.methods
      .contribute(new anchor.BN(1_000_000))
      .accountsPartial({
        contributor: provider.publicKey,
        fundraiser: c.fundraiser,
        contributorAccount: c.contributor,
        contributorAta: c.contributorAta.address,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    const state = await program.account.fundraiser.fetch(c.fundraiser);
    assert.equal(state.currentAmount.toNumber(), 1_000_000);
    assert.equal(state.matchRemaining.toNumber(), 0);
  });
});
