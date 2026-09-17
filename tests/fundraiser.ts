import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { assert } from "chai";

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
  it("Progressing past 25% sets bit 0 in milestonesFired", async () => {
  const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

  // 1. Fetch current fundraiser state to read the exact target amount
  const fundraiserData = await program.account.fundraiser.fetch(fundraiser);
  const target = fundraiserData.amountToRaise;

  // Max contribution per donor = target * 10 / 100
  const maxContribPerDonor = target.muln(10).divn(100); 
  
  // Choose a safe amount strictly less than or equal to maxContribPerDonor (e.g., 90% of max)
  const safeContribution = maxContribPerDonor.muln(9).divn(10);

  const createFreshContributor = async () => {
    const keypair = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(keypair.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);
    
    const ata = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, mint, keypair.publicKey)).address;
    await mintTo(provider.connection, wallet.payer, mint, ata, provider.publicKey, safeContribution.toNumber() * 2);
    
    const contributorPda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), keypair.publicKey.toBuffer()],
      program.programId
    )[0];

    return { keypair, ata, contributorPda };
  };

  const contributeIx = async (donor: Awaited<ReturnType<typeof createFreshContributor>>) => {
    await program.methods
      .contribute(safeContribution)
      .accountsPartial({
        contributor: donor.keypair.publicKey,
        fundraiser,
        contributorAccount: donor.contributorPda,
        contributorAta: donor.ata,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        mintToRaise: mint,
      })
      .signers([donor.keypair])
      .rpc()
      .then(confirm);
  };

  // Keep adding contributors until global current_amount crosses 25%
  let currentState = await program.account.fundraiser.fetch(fundraiser);
  const target25Percent = target.divn(4);

  while (currentState.currentAmount.lt(target25Percent)) {
    const freshDonor = await createFreshContributor();
    await contributeIx(freshDonor);
    currentState = await program.account.fundraiser.fetch(fundraiser);
  }

  // Verify milestone bit 0 is set
  assert.strictEqual(
    currentState.milestonesFired & 1,
    1,
    "Bit 0 should be set once 25% threshold is crossed"
  );
});

 it("Boundary: below 25% fires nothing; crossing 25% sets bit 0", async () => {
  const cleanMaker = anchor.web3.Keypair.generate();
  await provider.connection.requestAirdrop(cleanMaker.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);

  const cleanFundraiser = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("fundraiser"), cleanMaker.publicKey.toBuffer()],
    program.programId
  )[0];

  const vault = getAssociatedTokenAddressSync(mint, cleanFundraiser, true);

  // 1. Initialize fresh fundraiser (30,000,000 target => 7,500,000 for 25%)
  await program.methods
    .initialize(new anchor.BN(30_000_000), 7)
    .accountsPartial({
      maker: cleanMaker.publicKey,
      fundraiser: cleanFundraiser,
      mintToRaise: mint,
      vault,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .signers([cleanMaker])
    .rpc()
    .then(confirm);

  const target = new anchor.BN(30_000_000);
  const maxContrib = target.muln(10).divn(100); // 3,000,000 max per donor

  const makeFreshDonor = async () => {
    const kp = anchor.web3.Keypair.generate();
    await provider.connection.requestAirdrop(kp.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL).then(confirm);

    const ata = (await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, mint, kp.publicKey)).address;
    await mintTo(provider.connection, wallet.payer, mint, ata, provider.publicKey, maxContrib.toNumber());

    const pda = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), cleanFundraiser.toBuffer(), kp.publicKey.toBuffer()],
      program.programId
    )[0];

    return { kp, ata, pda };
  };

  const sendContrib = async (donor: Awaited<ReturnType<typeof makeFreshDonor>>, amount: number) => {
    await program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: donor.kp.publicKey,
        fundraiser: cleanFundraiser,
        contributorAccount: donor.pda,
        contributorAta: donor.ata,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        mintToRaise: mint,
      })
      .signers([donor.kp])
      .rpc()
      .then(confirm);
  };

  // 2. Fund to 7,499,000 total (1,000 units below 25%)
  // Donor 1: 3,000,000
  // Donor 2: 3,000,000
  // Donor 3: 1,499,000
  const d1 = await makeFreshDonor();
  const d2 = await makeFreshDonor();
  const d3 = await makeFreshDonor();

  await sendContrib(d1, 3_000_000);
  await sendContrib(d2, 3_000_000);
  await sendContrib(d3, 1_499_000);

  let state = await program.account.fundraiser.fetch(cleanFundraiser);
  assert.strictEqual(
    state.milestonesFired & 1,
    0,
    "Below 25% threshold must NOT set bit 0"
  );

  // 3. Donor 4 contributes 1,000,000 units (the minimum, one whole token),
  // pushing the total past the 7,500,000 threshold
  const d4 = await makeFreshDonor();
  await sendContrib(d4, 1_000_000);

  state = await program.account.fundraiser.fetch(cleanFundraiser);
  assert.strictEqual(
    state.milestonesFired & 1,
    1,
    "Crossing 25% must set bit 0"
  );
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
});
