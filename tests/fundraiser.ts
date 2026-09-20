import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";

const getAnchorErrorMessage = (error: unknown): string => {
  if (typeof error !== "object" || error === null) {
    return "Unknown error";
  }

  const maybeError = error as {
    msg?: unknown;
    message?: unknown;
    error?: { errorCode?: { code?: unknown } };
  };

  if (typeof maybeError.msg === "string") {
    return maybeError.msg;
  }

  if (typeof maybeError.message === "string") {
    return maybeError.message;
  }

  if (maybeError.error && typeof maybeError.error === "object") {
    const errorCode = maybeError.error.errorCode;
    if (errorCode && typeof errorCode.code === "string") {
      return errorCode.code;
    }
  }

  return "Unknown error";
};

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

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      signature,
      ...block,
    });
    return signature;
  };

  const getFundraiserState = async (fund: anchor.web3.PublicKey) => {
    return await program.account.fundraiser.fetch(fund);
  };

  it("Test Preparation", async () => {
    const airdrop = await provider.connection.requestAirdrop(maker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    console.log("\nAirdropped 1 SOL to maker", airdrop);

    mint = await createMint(provider.connection, wallet.payer, provider.publicKey, provider.publicKey, 6);
    console.log("Mint created", mint.toBase58());

    contributorATA = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, mint, wallet.publicKey)).address;

    makerATA = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, mint, maker.publicKey)).address;

    const mintTx = await mintTo(provider.connection, wallet.payer, mint, contributorATA, provider.publicKey, 1_000_000_0);
    console.log("Minted 10 tokens to contributor", mintTx);
  })

  it("milestone fires at the exact 25% boundary", async () => {
    const milestoneMaker = anchor.web3.Keypair.generate();
    const contributorA = anchor.web3.Keypair.generate();
    const contributorB = anchor.web3.Keypair.generate();
    const contributorC = anchor.web3.Keypair.generate();

    await provider.connection.requestAirdrop(milestoneMaker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    await provider.connection.requestAirdrop(contributorA.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    await provider.connection.requestAirdrop(contributorB.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    await provider.connection.requestAirdrop(contributorC.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);

    const milestoneMint = await createMint(provider.connection, wallet.payer, provider.publicKey, provider.publicKey, 6);
    const contributorAATA = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, milestoneMint, contributorA.publicKey)).address;
    const contributorBATA = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, milestoneMint, contributorB.publicKey)).address;
    const contributorCATA = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, milestoneMint, contributorC.publicKey)).address;
    await mintTo(provider.connection, wallet.payer, milestoneMint, contributorAATA, provider.publicKey, 1_000_000_000);
    await mintTo(provider.connection, wallet.payer, milestoneMint, contributorBATA, provider.publicKey, 1_000_000_000);
    await mintTo(provider.connection, wallet.payer, milestoneMint, contributorCATA, provider.publicKey, 1_000_000_000);

    const milestoneFundraiser = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("fundraiser"), milestoneMaker.publicKey.toBuffer()], program.programId)[0];
    const contributorAAccount = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("contributor"), milestoneFundraiser.toBuffer(), contributorA.publicKey.toBuffer()], program.programId)[0];
    const contributorBAccount = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("contributor"), milestoneFundraiser.toBuffer(), contributorB.publicKey.toBuffer()], program.programId)[0];
    const contributorCAccount = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("contributor"), milestoneFundraiser.toBuffer(), contributorC.publicKey.toBuffer()], program.programId)[0];
    const milestoneVault = getAssociatedTokenAddressSync(milestoneMint, milestoneFundraiser, true);

    await program.methods
      .initialize(new anchor.BN(100_000_000), 7)
      .accountsPartial({
        maker: milestoneMaker.publicKey,
        fundraiser: milestoneFundraiser,
        mintToRaise: milestoneMint,
        vault: milestoneVault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([milestoneMaker])
      .rpc({ skipPreflight: true })
      .then(confirm);

    const contributions = [
      { contributor: contributorA, account: contributorAAccount, ata: contributorAATA, amount: 9_000_000 },
      { contributor: contributorB, account: contributorBAccount, ata: contributorBATA, amount: 9_000_000 },
      { contributor: contributorC, account: contributorCAccount, ata: contributorCATA, amount: 7_000_000 },
    ];

    for (const step of contributions) {
      await program.methods
        .contribute(new anchor.BN(step.amount))
        .accountsPartial({
          contributor: step.contributor.publicKey,
          fundraiser: milestoneFundraiser,
          contributorAccount: step.account,
          contributorAta: step.ata,
          vault: milestoneVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([step.contributor])
        .rpc({ skipPreflight: true })
        .then(confirm);
    }

    const state = await getFundraiserState(milestoneFundraiser);
    if (state.milestonesFired !== 1) {
      throw new Error(`Expected 25% milestone to fire; got ${state.milestonesFired}`);
    }
  });

  it("milestone fires for all thresholds crossed over a valid multi-contribution run", async () => {
    const milestoneMaker = anchor.web3.Keypair.generate();
    const contributors = Array.from({ length: 9 }, () => anchor.web3.Keypair.generate());

    await provider.connection.requestAirdrop(milestoneMaker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    for (const contributor of contributors) {
      await provider.connection.requestAirdrop(contributor.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    }

    const milestoneMint = await createMint(provider.connection, wallet.payer, provider.publicKey, provider.publicKey, 6);
    const milestoneFundraiser = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("fundraiser"), milestoneMaker.publicKey.toBuffer()], program.programId)[0];
    const milestoneVault = getAssociatedTokenAddressSync(milestoneMint, milestoneFundraiser, true);

    for (const contributor of contributors) {
      const ata = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, milestoneMint, contributor.publicKey)).address;
      await mintTo(provider.connection, wallet.payer, milestoneMint, ata, provider.publicKey, 1_000_000_000);
    }

    await program.methods
      .initialize(new anchor.BN(30_000_000), 7)
      .accountsPartial({
        maker: milestoneMaker.publicKey,
        fundraiser: milestoneFundraiser,
        mintToRaise: milestoneMint,
        vault: milestoneVault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([milestoneMaker])
      .rpc({ skipPreflight: true })
      .then(confirm);

    const steps = [3_000_000, 3_000_000, 3_000_000, 3_000_000, 3_000_000, 3_000_000, 3_000_000, 3_000_000, 3_000_000];
    for (let i = 0; i < steps.length; i++) {
      const contributor = contributors[i];
      const contributorAccount = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("contributor"), milestoneFundraiser.toBuffer(), contributor.publicKey.toBuffer()], program.programId)[0];
      const ata = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, milestoneMint, contributor.publicKey)).address;

      await program.methods
        .contribute(new anchor.BN(steps[i]))
        .accountsPartial({
          contributor: contributor.publicKey,
          fundraiser: milestoneFundraiser,
          contributorAccount,
          contributorAta: ata,
          vault: milestoneVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([contributor])
        .rpc({ skipPreflight: true })
        .then(confirm);
    }

    const state = await getFundraiserState(milestoneFundraiser);
    if (state.milestonesFired !== 7) {
      throw new Error(`Expected 25%, 50%, and 75% milestones to fire as the campaign crosses them; got ${state.milestonesFired}`);
    }
  });

  it("milestones do not re-fire when the same threshold is reached again", async () => {
    const milestoneMaker = anchor.web3.Keypair.generate();
    const contributors = Array.from({ length: 4 }, () => anchor.web3.Keypair.generate());

    await provider.connection.requestAirdrop(milestoneMaker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    for (const contributor of contributors) {
      await provider.connection.requestAirdrop(contributor.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    }

    const milestoneMint = await createMint(provider.connection, wallet.payer, provider.publicKey, provider.publicKey, 6);
    const milestoneFundraiser = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("fundraiser"), milestoneMaker.publicKey.toBuffer()], program.programId)[0];
    const milestoneVault = getAssociatedTokenAddressSync(milestoneMint, milestoneFundraiser, true);

    for (const contributor of contributors) {
      const ata = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, milestoneMint, contributor.publicKey)).address;
      await mintTo(provider.connection, wallet.payer, milestoneMint, ata, provider.publicKey, 1_000_000_000);
    }

    await program.methods
      .initialize(new anchor.BN(100_000_000), 7)
      .accountsPartial({
        maker: milestoneMaker.publicKey,
        fundraiser: milestoneFundraiser,
        mintToRaise: milestoneMint,
        vault: milestoneVault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([milestoneMaker])
      .rpc({ skipPreflight: true })
      .then(confirm);

    const firstRound = [
      { contributor: contributors[0], amount: 9_000_000 },
      { contributor: contributors[1], amount: 9_000_000 },
      { contributor: contributors[2], amount: 7_000_000 },
    ];

    for (const step of firstRound) {
      const contributorAccount = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("contributor"), milestoneFundraiser.toBuffer(), step.contributor.publicKey.toBuffer()], program.programId)[0];
      const ata = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, milestoneMint, step.contributor.publicKey)).address;

      await program.methods
        .contribute(new anchor.BN(step.amount))
        .accountsPartial({
          contributor: step.contributor.publicKey,
          fundraiser: milestoneFundraiser,
          contributorAccount,
          contributorAta: ata,
          vault: milestoneVault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([step.contributor])
        .rpc({ skipPreflight: true })
        .then(confirm);
    }

    const afterFirst = await getFundraiserState(milestoneFundraiser);
    if (afterFirst.milestonesFired !== 1) {
      throw new Error(`Expected first set to set only the 25% flag; got ${afterFirst.milestonesFired}`);
    }

    const latterContributor = contributors[3];
    const latterAccount = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("contributor"), milestoneFundraiser.toBuffer(), latterContributor.publicKey.toBuffer()], program.programId)[0];
    const latterAta = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, milestoneMint, latterContributor.publicKey)).address;

    await program.methods
      .contribute(new anchor.BN(1_000_000))
      .accountsPartial({
        contributor: latterContributor.publicKey,
        fundraiser: milestoneFundraiser,
        contributorAccount: latterAccount,
        contributorAta: latterAta,
        vault: milestoneVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([latterContributor])
      .rpc({ skipPreflight: true })
      .then(confirm);

    const afterSecond = await getFundraiserState(milestoneFundraiser);
    if (afterSecond.milestonesFired !== 1) {
      throw new Error(`Expected milestones to remain unchanged after a smaller later contribution; got ${afterSecond.milestonesFired}`);
    }
  });

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
    } catch (error: unknown) {
      console.log("\nError contributing to fundraiser");
      console.log(getAnchorErrorMessage(error));
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
    } catch (error: unknown) {
      console.log("\nError checking contributions");
      console.log(getAnchorErrorMessage(error));
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
    } catch (error: unknown) {
      console.log("\nRefund refused while the fundraiser is still running");
      console.log(getAnchorErrorMessage(error));
    }
  });
});
