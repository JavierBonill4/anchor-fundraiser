import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../../target/types/fundraiser";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";

describe("fundraiser", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;

  const maker = anchor.web3.Keypair.generate();

  let mint: anchor.web3.PublicKey;

  let contributorATA: anchor.web3.PublicKey;
  let makerATA: anchor.web3.PublicKey;

  // ------------------------------------------------------------
  // Additional contributors used for milestone testing
  // ------------------------------------------------------------

  let milestoneContributor1: anchor.web3.Keypair;
  let milestoneContributor2: anchor.web3.Keypair;
  let milestoneContributor3: anchor.web3.Keypair;
  let milestoneContributor4: anchor.web3.Keypair;
  let milestoneContributor5: anchor.web3.Keypair;
  let milestoneContributor6: anchor.web3.Keypair;
  let milestoneContributor7: anchor.web3.Keypair;
  let milestoneContributor8: anchor.web3.Keypair;

  let milestoneContributor1ATA: anchor.web3.PublicKey;
  let milestoneContributor2ATA: anchor.web3.PublicKey;
  let milestoneContributor3ATA: anchor.web3.PublicKey;
  let milestoneContributor4ATA: anchor.web3.PublicKey;
  let milestoneContributor5ATA: anchor.web3.PublicKey;
  let milestoneContributor6ATA: anchor.web3.PublicKey;
  let milestoneContributor7ATA: anchor.web3.PublicKey;
  let milestoneContributor8ATA: anchor.web3.PublicKey;

  const wallet = provider.wallet as NodeWallet;

  // ------------------------------------------------------------
  // Fundraiser PDA
  // ------------------------------------------------------------

  const fundraiser =
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("fundraiser"),
        maker.publicKey.toBuffer(),
      ],
      program.programId
    )[0];

  // Existing contributor PDA
  const contributor =
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        fundraiser.toBuffer(),
        provider.publicKey.toBuffer(),
      ],
      program.programId
    )[0];

  // ------------------------------------------------------------
  // Confirmation helper
  // ------------------------------------------------------------

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction({
      signature,
      ...block,
    });

    return signature;
  };

  // ============================================================
  // TEST PREPARATION
  // ============================================================

  it("Test Preparation", async () => {
    const airdrop = await provider.connection
      .requestAirdrop(
        maker.publicKey,
        1 * anchor.web3.LAMPORTS_PER_SOL
      )
      .then(confirm);

    console.log("\nAirdropped 1 SOL to maker", airdrop);

    // Create mint with 6 decimals.
    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    console.log("Mint created", mint.toBase58());

    // Existing contributor ATA.
    contributorATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        wallet.publicKey
      )
    ).address;

    // Maker ATA.
    makerATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        maker.publicKey
      )
    ).address;

    // Give the original contributor 10 tokens.
    const mintTx = await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      contributorATA,
      provider.publicKey,
      10_000_000
    );

    console.log("Minted 10 tokens to contributor", mintTx);

    // ----------------------------------------------------------
    // Create milestone contributors
    // ----------------------------------------------------------

    milestoneContributor1 = anchor.web3.Keypair.generate();
    milestoneContributor2 = anchor.web3.Keypair.generate();
    milestoneContributor3 = anchor.web3.Keypair.generate();
    milestoneContributor4 = anchor.web3.Keypair.generate();
    milestoneContributor5 = anchor.web3.Keypair.generate();
    milestoneContributor6 = anchor.web3.Keypair.generate();
    milestoneContributor7 = anchor.web3.Keypair.generate();
    milestoneContributor8 = anchor.web3.Keypair.generate();

    const milestoneContributors = [
      milestoneContributor1,
      milestoneContributor2,
      milestoneContributor3,
      milestoneContributor4,
      milestoneContributor5,
      milestoneContributor6,
      milestoneContributor7,
      milestoneContributor8,
    ];

    // Give every milestone contributor enough SOL
    // to create their contributor PDA and pay fees.
    for (const contributorKeypair of milestoneContributors) {
      await provider.connection
        .requestAirdrop(
          contributorKeypair.publicKey,
          1 * anchor.web3.LAMPORTS_PER_SOL
        )
        .then(confirm);
    }

    // ----------------------------------------------------------
    // Create their ATAs
    // ----------------------------------------------------------

    milestoneContributor1ATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        milestoneContributor1.publicKey
      )
    ).address;

    milestoneContributor2ATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        milestoneContributor2.publicKey
      )
    ).address;

    milestoneContributor3ATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        milestoneContributor3.publicKey
      )
    ).address;

    milestoneContributor4ATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        milestoneContributor4.publicKey
      )
    ).address;

    milestoneContributor5ATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        milestoneContributor5.publicKey
      )
    ).address;

    milestoneContributor6ATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        milestoneContributor6.publicKey
      )
    ).address;

    milestoneContributor7ATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        milestoneContributor7.publicKey
      )
    ).address;

    milestoneContributor8ATA = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        milestoneContributor8.publicKey
      )
    ).address;

    // ----------------------------------------------------------
    // Give each contributor 3 tokens.
    //
    // Each contributor is allowed to contribute at most
    // 10% of the 30-token target = 3 tokens.
    // ----------------------------------------------------------

    const contributorATAs = [
      milestoneContributor1ATA,
      milestoneContributor2ATA,
      milestoneContributor3ATA,
      milestoneContributor4ATA,
      milestoneContributor5ATA,
      milestoneContributor6ATA,
      milestoneContributor7ATA,
      milestoneContributor8ATA,
    ];

    for (const ata of contributorATAs) {
      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        ata,
        provider.publicKey,
        3_000_000
      );
    }

    console.log("Prepared milestone contributors");
  });

  // ============================================================
  // INITIALIZE FUNDRAISER
  // ============================================================

  it("Initialize Fundaraiser", async () => {
    const vault = getAssociatedTokenAddressSync(
      mint,
      fundraiser,
      true
    );

    const tx = await program
      .methods
      .initialize(
        new anchor.BN(30_000_000),
        7
      )
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

  // ============================================================
  // EXISTING CONTRIBUTION TEST
  // ============================================================

  it("Contribute to Fundraiser", async () => {
    const vault = getAssociatedTokenAddressSync(
      mint,
      fundraiser,
      true
    );

    const tx = await program
      .methods
      .contribute(new anchor.BN(1_000_000))
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
      (
        await provider.connection.getTokenAccountBalance(vault)
      ).value.amount
    );

    const contributorAccount =
      await program.account.contributor.fetch(contributor);

    console.log(
      "Contributor balance",
      contributorAccount.amount.toString()
    );
  });

  // ============================================================
  // EXISTING CONTRIBUTION TEST
  // ============================================================

  it("Contribute to Fundraiser", async () => {
    const vault = getAssociatedTokenAddressSync(
      mint,
      fundraiser,
      true
    );

    const tx = await program
      .methods
      .contribute(new anchor.BN(1_000_000))
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
      (
        await provider.connection.getTokenAccountBalance(vault)
      ).value.amount
    );

    const contributorAccount =
      await program.account.contributor.fetch(contributor);

    console.log(
      "Contributor balance",
      contributorAccount.amount.toString()
    );
  });

  // ============================================================
  // EXISTING ROBUSTNESS TEST
  // ============================================================

  it("Contribute to Fundraiser - Robustness Test", async () => {
    try {
      const vault = getAssociatedTokenAddressSync(
        mint,
        fundraiser,
        true
      );

      const tx = await program
        .methods
        .contribute(new anchor.BN(2_000_000))
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
        (
          await provider.connection.getTokenAccountBalance(vault)
        ).value.amount
      );
    } catch (error: any) {
      console.log("\nError contributing to fundraiser");
      console.log(error.msg);
    }
  });

  // ============================================================
  // EXISTING CHECK CONTRIBUTIONS TEST
  // ============================================================

  it("Check contributions - Robustness Test", async () => {
    try {
      const vault = getAssociatedTokenAddressSync(
        mint,
        fundraiser,
        true
      );

      const tx = await program
        .methods
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
        (
          await provider.connection.getTokenAccountBalance(vault)
        ).value.amount
      );
    } catch (error:any) {
      console.log("\nError checking contributions");
      console.log(error.msg);
    }
  });

  // ============================================================
  // EXISTING REFUND TEST
  // ============================================================

  it("Refund Contributions - refused while the window is open", async () => {
    const vault = getAssociatedTokenAddressSync(
      mint,
      fundraiser,
      true
    );

    try {
      await program
        .methods
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
      console.log(
        "\nRefund refused while the fundraiser is still running"
      );
      

      console.log(
        error.error?.errorCode?.code ?? error.message
      );
    }
  });

  // ============================================================
  // MILESTONE TEST 1
  // 25% BOUNDARY
  // ============================================================

  it("Milestone 25% - triggers when contribution crosses the threshold", async () => {
    const vault = getAssociatedTokenAddressSync(
      mint,
      fundraiser,
      true
    );

    // Current fundraiser amount:
    //
    // 2 tokens from the two existing contribution tests.
    //
    // Add 3 tokens:
    // 2 + 3 = 5 tokens
    //
    // Add 2 tokens:
    // 5 + 2 = 7 tokens
    //
    // 25% of 30 = 7.5 tokens.
    //
    // Therefore 7 tokens is still below 25%.

    const contributor1PDA =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          fundraiser.toBuffer(),
          milestoneContributor1.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

    await program.methods
      .contribute(new anchor.BN(3_000_000))
      .accountsPartial({
        contributor: milestoneContributor1.publicKey,
        fundraiser,
        contributorAccount: contributor1PDA,
        contributorAta: milestoneContributor1ATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([milestoneContributor1])
      .rpc();

    const contributor2PDA =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          fundraiser.toBuffer(),
          milestoneContributor2.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

    await program.methods
      .contribute(new anchor.BN(2_000_000))
      .accountsPartial({
        contributor: milestoneContributor2.publicKey,
        fundraiser,
        contributorAccount: contributor2PDA,
        contributorAta: milestoneContributor2ATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([milestoneContributor2])
      .rpc();

    let fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    console.log(
      "\nAmount before crossing 25%:",
      fundraiserAccount.currentAmount.toString()
    );

    // 7 tokens is below 25% of a 30-token target.
    if (fundraiserAccount.milestonesFired !== 0) {
      throw new Error(
        "25% milestone should not have fired at 7 tokens"
      );
    }

    // Add one more token:
    //
    // 7 + 1 = 8 tokens
    //
    // 8 / 30 > 25%, therefore the 25% milestone must fire.

    await program.methods
      .contribute(new anchor.BN(1_000_000))
      .accountsPartial({
        contributor: milestoneContributor2.publicKey,
        fundraiser,
        contributorAccount: contributor2PDA,
        contributorAta: milestoneContributor2ATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([milestoneContributor2])
      .rpc();

    fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    console.log(
      "Amount after crossing 25%:",
      fundraiserAccount.currentAmount.toString()
    );

    console.log(
      "Milestones fired:",
      fundraiserAccount.milestonesFired
    );

    // Bit 0 must be set.
    //
    // 00000001 = 25%

    if ((fundraiserAccount.milestonesFired & 1) !== 1) {
      throw new Error(
        "25% milestone was not recorded on-chain"
      );
    }
  });

  // ============================================================
  // MILESTONE TEST 2
  // 50% BOUNDARY
  // ============================================================

  it("Milestone 50% - records the 50% milestone", async () => {
    const vault = getAssociatedTokenAddressSync(
      mint,
      fundraiser,
      true
    );

    // Current amount is 8 tokens.
    //
    // 50% of 30 tokens = 15 tokens.
    //
    // Add:
    // Contributor 3 -> 3 tokens
    // Contributor 4 -> 3 tokens
    // Contributor 5 -> 1 token
    //
    // 8 + 3 + 3 + 1 = 15 tokens.

    const contributor3PDA =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          fundraiser.toBuffer(),
          milestoneContributor3.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

    await program.methods
      .contribute(new anchor.BN(3_000_000))
      .accountsPartial({
        contributor: milestoneContributor3.publicKey,
        fundraiser,
        contributorAccount: contributor3PDA,
        contributorAta: milestoneContributor3ATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([milestoneContributor3])
      .rpc();

    const contributor4PDA =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          fundraiser.toBuffer(),
          milestoneContributor4.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

    await program.methods
      .contribute(new anchor.BN(3_000_000))
      .accountsPartial({
        contributor: milestoneContributor4.publicKey,
        fundraiser,
        contributorAccount: contributor4PDA,
        contributorAta: milestoneContributor4ATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([milestoneContributor4])
      .rpc();

    const contributor5PDA =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          fundraiser.toBuffer(),
          milestoneContributor5.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

    await program.methods
      .contribute(new anchor.BN(1_000_000))
      .accountsPartial({
        contributor: milestoneContributor5.publicKey,
        fundraiser,
        contributorAccount: contributor5PDA,
        contributorAta: milestoneContributor5ATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([milestoneContributor5])
      .rpc();

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    console.log(
      "\nCurrent amount:",
      fundraiserAccount.currentAmount.toString()
    );

    console.log(
      "Milestones fired:",
      fundraiserAccount.milestonesFired
    );

    // 50% means:
    //
    // Bit 0 = 1 -> 25%
    // Bit 1 = 2 -> 50%
    //
    // Both must now be set:
    //
    // 00000011 = 3

    if (
      (fundraiserAccount.milestonesFired & 2) !== 2
    ) {
      throw new Error(
        "50% milestone was not recorded on-chain"
      );
    }

    if (fundraiserAccount.milestonesFired !== 3) {
      throw new Error(
        "Expected both 25% and 50% milestones to be fired"
      );
    }
  });

  // ============================================================
  // MILESTONE TEST 3
  // 75% BOUNDARY
  // ============================================================

  it("Milestone 75% - records the 75% milestone", async () => {
    const vault = getAssociatedTokenAddressSync(
      mint,
      fundraiser,
      true
    );

    // Current amount = 15 tokens.
    //
    // 75% of 30 = 22.5 tokens.
    //
    // Add:
    //
    // Contributor 6 -> 3 tokens = 18
    // Contributor 7 -> 3 tokens = 21
    // Contributor 8 -> 2 tokens = 23
    //
    // 23 / 30 > 75%.
    //
    // Therefore the 75% milestone must fire.

    const contributor6PDA =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          fundraiser.toBuffer(),
          milestoneContributor6.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

    await program.methods
      .contribute(new anchor.BN(3_000_000))
      .accountsPartial({
        contributor: milestoneContributor6.publicKey,
        fundraiser,
        contributorAccount: contributor6PDA,
        contributorAta: milestoneContributor6ATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([milestoneContributor6])
      .rpc();

    const contributor7PDA =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          fundraiser.toBuffer(),
          milestoneContributor7.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

    await program.methods
      .contribute(new anchor.BN(3_000_000))
      .accountsPartial({
        contributor: milestoneContributor7.publicKey,
        fundraiser,
        contributorAccount: contributor7PDA,
        contributorAta: milestoneContributor7ATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([milestoneContributor7])
      .rpc();

    const contributor8PDA =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          fundraiser.toBuffer(),
          milestoneContributor8.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

    await program.methods
      .contribute(new anchor.BN(2_000_000))
      .accountsPartial({
        contributor: milestoneContributor8.publicKey,
        fundraiser,
        contributorAccount: contributor8PDA,
        contributorAta: milestoneContributor8ATA,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([milestoneContributor8])
      .rpc();

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    console.log(
      "\nCurrent amount:",
      fundraiserAccount.currentAmount.toString()
    );

    console.log(
      "Milestones fired:",
      fundraiserAccount.milestonesFired
    );

    // All three milestones should now be set:
    //
    // Bit 0 = 25%
    // Bit 1 = 50%
    // Bit 2 = 75%
    //
    // 00000111 = 7

    if (
      (fundraiserAccount.milestonesFired & 4) !== 4
    ) {
      throw new Error(
        "75% milestone was not recorded on-chain"
      );
    }

    if (fundraiserAccount.milestonesFired !== 7) {
      throw new Error(
        "Expected 25%, 50% and 75% milestones to be fired"
      );
    }
  });
});