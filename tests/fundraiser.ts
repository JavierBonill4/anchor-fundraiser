import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { createMint, createAssociatedTokenAccount, mintTo } from "spl-token-bankrun";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { Clock } from "solana-bankrun";
import assert from "assert";


describe("fundraiser", () => {
  let provider: BankrunProvider;
  let program: Program<Fundraiser>;
  let context: any;

  const maker = anchor.web3.Keypair.generate();
  const contributorKeypair = anchor.web3.Keypair.generate();
  
  let mint: anchor.web3.PublicKey;
  let contributorATA: anchor.web3.PublicKey;
  let makerATA: anchor.web3.PublicKey;

  let fundraiser: anchor.web3.PublicKey;
  let contributorAccount: anchor.web3.PublicKey;
  let receiptMint: anchor.web3.PublicKey;
  let contributorReceiptAta: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;

  // We use a single before() hook to handle all Bankrun asynchronous setup
  before(async () => {
    context = await startAnchor("", [], []);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    
    // Re-bind the program to use the Bankrun provider instead of the default local validator
    const workspaceProgram = anchor.workspace.Fundraiser as Program<Fundraiser>;
    program = new Program(workspaceProgram.idl, provider) as Program<Fundraiser>;

    // Derive PDAs
    fundraiser = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("fundraiser"), maker.publicKey.toBuffer()], program.programId)[0];
    contributorAccount = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("contributor"), fundraiser.toBuffer(), contributorKeypair.publicKey.toBuffer()], program.programId)[0];
    receiptMint = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("receipt"), fundraiser.toBuffer(), contributorKeypair.publicKey.toBuffer()], program.programId)[0];
    contributorReceiptAta = getAssociatedTokenAddressSync(receiptMint, contributorKeypair.publicKey);

    // Execute Test Preparation logic securely inside the hook
    const systemProgram = anchor.web3.SystemProgram.programId;
    
    context.setAccount(maker.publicKey, {
      lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
      data: Buffer.alloc(0),
      owner: systemProgram,
      executable: false,
    });
    
    context.setAccount(contributorKeypair.publicKey, {
      lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
      data: Buffer.alloc(0),
      owner: systemProgram,
      executable: false,
    });

    // Use banksClient to create mints and accounts exclusively in Bankrun
    mint = await createMint(context.banksClient, maker, maker.publicKey, maker.publicKey, 6);
    vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    contributorATA = await createAssociatedTokenAccount(context.banksClient, maker, mint, contributorKeypair.publicKey);
    makerATA = await createAssociatedTokenAccount(context.banksClient, maker, mint, maker.publicKey);

    await mintTo(context.banksClient, maker, mint, contributorATA, maker, 1_000_000_0);
  });

  it("Initialize Fundraiser", async () => {
    await program.methods
      .initialize(new anchor.BN(30000000), 7)
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
      .rpc();
  });

  it("Contribute & Verify NFT Minting (Happy Path)", async () => {
    await program.methods
      .contribute(new anchor.BN(1000000))
      .accountsPartial({
        contributor: contributorKeypair.publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount,
        contributorAta: contributorATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        // NEW: Pass the receipt accounts
        receiptMint,
        contributorReceiptAta,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([contributorKeypair])
      .rpc();

    // Verify the contributor state
    let state = await program.account.contributor.fetch(contributorAccount);
    assert.strictEqual(state.amount.toNumber(), 1000000);

      // Verify the NFT was minted
    const receiptAccount = await getAccount(provider.connection, contributorReceiptAta);
    assert.strictEqual(Number(receiptAccount.amount), 1, "Contributor should have exactly 1 NFT receipt");
  }); 

  it("Refund Refused (Abuse Case: Time Window Still Open)", async () => {
    try {
      await program.methods
        .refund()
        .accountsPartial({
          contributor: contributorKeypair.publicKey,
          maker: maker.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount,
          contributorAta: contributorATA,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          receiptMint,
          contributorReceiptAta,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([contributorKeypair])
        .rpc();
      
      assert.fail("Expected the refund to be rejected");
    } catch (err: any) {
      // Assert the specific custom error code from Anchor, not just a generic failure
      assert.strictEqual(err.error.errorCode.code, "FundraiserNotEnded");
    }
  });

  it("Time Travel & Refund (Boundary)", async () => {
    // 1. Manually advance the Bankrun clock by 15 days
    const clock = await context.banksClient.getClock();
    context.setClock(new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      clock.unixTimestamp + BigInt(15 * 86_400),
    ));

    // 2. Execute the refund now that the deadline has passed
    await program.methods
      .refund()
      .accountsPartial({
        contributor: contributorKeypair.publicKey,
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount,
        contributorAta: contributorATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        receiptMint,
        contributorReceiptAta,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([contributorKeypair])
      .rpc();

    // 3. Verify the NFT was burned as part of the refund trap
    try {
      const receiptAccount = await getAccount(provider.connection, contributorReceiptAta);
      assert.strictEqual(Number(receiptAccount.amount), 0, "NFT receipt should be burned after refund");
    } catch (err: any) {
      // If your program closed the token account completely after burning the token,
      // getAccount will throw a TokenAccountNotFoundError. Both mean the NFT is successfully gone!
      assert.strictEqual(err.name, "TokenAccountNotFoundError");
    }
  });
});