import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { assert } from "chai";

// The program caps any one contributor at 10% of the target and requires at
// least one whole token, so a 10-token target makes those two limits equal:
// every contributor gives exactly 1 token, and it takes exactly ten of them to
// fill the vault.
const DECIMALS = 6;
const ONE_TOKEN = 10 ** DECIMALS;
const TARGET = 10 * ONE_TOKEN;
const PER_CONTRIBUTOR = ONE_TOKEN;
const REWARD_RATE = 10; // must match REWARD_RATE in constants.rs

describe("fundraiser — contributor reward token", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const maker = anchor.web3.Keypair.generate();
  const backers = Array.from({ length: 10 }, () => anchor.web3.Keypair.generate());

  let mint: anchor.web3.PublicKey;
  let fundraiser: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;
  let rewardMint: anchor.web3.PublicKey;

  const contributorAccount = (backer: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), backer.toBuffer()],
      program.programId
    )[0];

  const contribute = (backer: anchor.web3.Keypair) =>
    program.methods
      .contribute(new anchor.BN(PER_CONTRIBUTOR))
      .accountsPartial({
        contributor: backer.publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount: contributorAccount(backer.publicKey),
        contributorAta: getAssociatedTokenAddressSync(mint, backer.publicKey),
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([backer])
      .rpc();

  // `accountOverride` lets the abuse test point at somebody else's contributor
  // account while still signing as itself.
  const claim = (backer: anchor.web3.Keypair, accountOverride?: anchor.web3.PublicKey) =>
    program.methods
      .claimReward()
      .accountsPartial({
        contributor: backer.publicKey,
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount: accountOverride ?? contributorAccount(backer.publicKey),
        rewardMint,
        contributorRewardAta: getAssociatedTokenAddressSync(rewardMint, backer.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([backer])
      .rpc();

  before(async () => {
    const confirm = async (sig: string) => {
      const block = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({ signature: sig, ...block });
      return sig;
    };

    await provider.connection
      .requestAirdrop(maker.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      DECIMALS
    );

    fundraiser = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    )[0];
    vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    rewardMint = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward"), fundraiser.toBuffer()],
      program.programId
    )[0];

    await program.methods
      .initialize(new anchor.BN(TARGET), 7)
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    // Fund every backer with SOL for rent and fees, and one token to give.
    for (const backer of backers) {
      await provider.connection
        .requestAirdrop(backer.publicKey, anchor.web3.LAMPORTS_PER_SOL)
        .then(confirm);
      const ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        backer.publicKey
      );
      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        ata.address,
        provider.publicKey,
        PER_CONTRIBUTOR
      );
    }
  });

  it("refuses to pay out while the vault is one contribution short", async () => {
    // Nine of ten backers: 90% of the target.
    for (const backer of backers.slice(0, 9)) {
      await contribute(backer);
    }

    const state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.currentAmount.toNumber(), 9 * PER_CONTRIBUTOR);

    try {
      await claim(backers[0]);
      assert.fail("a claim below the target must be rejected");
    } catch (err) {
      assert.strictEqual(err.error.errorCode.code, "TargetNotMet");
    }
  });

  it("pays out at exactly the target", async () => {
    // The tenth contribution lands the vault on the target exactly, which is
    // what separates `>=` from `>` in the claim gate.
    await contribute(backers[9]);

    const state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.currentAmount.toNumber(), TARGET);

    const sig = await claim(backers[0]);
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...block });
    const meta = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    console.log("      claim_reward CUs:", meta?.meta?.computeUnitsConsumed);

    const ata = getAssociatedTokenAddressSync(rewardMint, backers[0].publicKey);
    const balance = (await getAccount(provider.connection, ata)).amount;
    assert.strictEqual(
      Number(balance),
      PER_CONTRIBUTOR * REWARD_RATE,
      "reward should be the contribution times the rate"
    );

    const contributorState = await program.account.contributor.fetch(
      contributorAccount(backers[0].publicKey)
    );
    assert.isTrue(contributorState.rewardsClaimed, "the claim flag should be set");
  });

  it("refuses a second claim from the same contributor", async () => {
    // The target stays met forever, so without the flag this would mint again
    // on every call.
    try {
      await claim(backers[0]);
      assert.fail("the second claim must be rejected");
    } catch (err) {
      assert.strictEqual(err.error.errorCode.code, "RewardAlreadyClaimed");
    }
  });

  it("refuses a claim against someone else's contributor account", async () => {
    // backers[1] signs, but points at backers[2]'s contributor account to try
    // to mint their entitlement into its own wallet. The seeds bind the
    // account to the signer, so the derivation no longer matches.
    try {
      await claim(backers[1], contributorAccount(backers[2].publicKey));
      assert.fail("claiming against another contributor's account must be rejected");
    } catch (err) {
      assert.strictEqual(err.error.errorCode.code, "ConstraintSeeds");
    }

    // And the victim's entitlement is untouched.
    const victim = await program.account.contributor.fetch(
      contributorAccount(backers[2].publicKey)
    );
    assert.isFalse(victim.rewardsClaimed);
  });
});
