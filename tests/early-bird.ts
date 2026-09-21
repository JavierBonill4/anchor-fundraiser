import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { assert } from "chai";

describe("Early Bird Curve Feature", () => {
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const maker = anchor.web3.Keypair.generate();
  const wallet = provider.wallet as NodeWallet;

  let mint: anchor.web3.PublicKey;
  
  const fundraiser = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("fundraiser"), maker.publicKey.toBuffer()], program.programId)[0];
  const rewardMint = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("reward"), fundraiser.toBuffer()], program.programId)[0];

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  it("Setup", async() => {
    await provider.connection.requestAirdrop(maker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    mint = await createMint(provider.connection, wallet.payer, provider.publicKey, provider.publicKey, 6);
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new anchor.BN(30_000_000), 7)
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
      .rpc({skipPreflight: true}).then(confirm);
  });

  it("Happy Path: Contributes early and gets rewards", async () => {
    const contributor = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(contributor.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    
    const contributorATA = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, mint, contributor.publicKey)).address;
    await mintTo(provider.connection, wallet.payer, mint, contributorATA, provider.publicKey, 3_000_000);
    
    const contributorAccount = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("contributor"), fundraiser.toBuffer(), contributor.publicKey.toBuffer()], program.programId)[0];
    const contributorRewardAta = getAssociatedTokenAddressSync(rewardMint, contributor.publicKey, true);
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    
    const target = 30_000_000;
    const current = 0;
    const remaining = target - current;
    const contribution = 1_000_000;
    const expectedReward = Math.floor((contribution * remaining) / target);
    
    await program.methods
      .contribute(new anchor.BN(contribution))
      .accountsPartial({
        contributor: contributor.publicKey,
        fundraiser,
        contributorAccount,
        contributorAta: contributorATA,
        vault,
        rewardMint,
        contributorRewardAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([contributor])
      .rpc({skipPreflight: true}).then(confirm);
      
    const rewardAtaBalance = (await provider.connection.getTokenAccountBalance(contributorRewardAta)).value.amount;
    assert.strictEqual(rewardAtaBalance, expectedReward.toString(), "Reward amount incorrect");
  });

  it("Boundary: Vault is full, reward should be 0", async () => {
    const contributor2 = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(contributor2.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    
    const contributorATA = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, mint, contributor2.publicKey)).address;
    await mintTo(provider.connection, wallet.payer, mint, contributorATA, provider.publicKey, 2_000_000);
    
    const contributorAccount = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("contributor"), fundraiser.toBuffer(), contributor2.publicKey.toBuffer()], program.programId)[0];
    const contributorRewardAta = getAssociatedTokenAddressSync(rewardMint, contributor2.publicKey, true);
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    
    const target = 30_000_000;
    const current = 1_000_000;
    const remaining = target - current;
    const contribution = 1_000_000;
    const expectedReward = Math.floor((contribution * remaining) / target);
    
    await program.methods
      .contribute(new anchor.BN(contribution))
      .accountsPartial({
        contributor: contributor2.publicKey,
        fundraiser,
        contributorAccount,
        contributorAta: contributorATA,
        vault,
        rewardMint,
        contributorRewardAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([contributor2])
      .rpc({skipPreflight: true}).then(confirm);
      
    const rewardAtaBalance = (await provider.connection.getTokenAccountBalance(contributorRewardAta)).value.amount;
    assert.strictEqual(rewardAtaBalance, expectedReward.toString(), "Boundary reward incorrect");
  });
});
