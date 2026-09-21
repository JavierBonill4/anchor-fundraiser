import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { Fundraiser } from "../target/types/fundraiser";

describe("fundraiser milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;
  const maker = anchor.web3.Keypair.generate();

  const targetAmount = 40_000_000; // 40 tokens with 6 decimals

  const fundraiser = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
    program.programId,
  )[0];

  let mint: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;

  const confirm = async (signature: string): Promise<void> => {
    const blockhash = await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction({
      signature,
      ...blockhash,
    });
  };

  before(async () => {
    const airdropSignature = await provider.connection.requestAirdrop(
      maker.publicKey,
      anchor.web3.LAMPORTS_PER_SOL,
    );

    await confirm(airdropSignature);

    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6,
    );

    vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new anchor.BN(targetAmount), 7)
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
  });
  const contributeTokens = async (
    tokens: number,
    contributor = anchor.web3.Keypair.generate(),
  ): Promise<anchor.web3.Keypair> => {
    const airdropSignature = await provider.connection.requestAirdrop(
      contributor.publicKey,
      anchor.web3.LAMPORTS_PER_SOL,
    );

    await confirm(airdropSignature);

    const contributorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        contributor.publicKey,
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      contributorAta,
      provider.publicKey,
      tokens * 1_000_000,
    );

    const contributorAccount = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        fundraiser.toBuffer(),
        contributor.publicKey.toBuffer(),
      ],
      program.programId,
    )[0];

    await program.methods
      .contribute(new anchor.BN(tokens * 1_000_000))
      .accountsPartial({
        contributor: contributor.publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount,
        contributorAta,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor])
      .rpc();

    return contributor;
  };
  it("fires the first milestone exactly at 25 percent", async () => {
    await contributeTokens(4);
    await contributeTokens(4);
    await contributeTokens(1);

    let fundraiserAccount = await program.account.fundraiser.fetch(fundraiser);

    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      0,
      "The 25% milestone must not fire at 9 tokens",
    );

    await contributeTokens(1);

    fundraiserAccount = await program.account.fundraiser.fetch(fundraiser);

    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      1,
      "The 25% milestone must fire exactly at 10 tokens",
    );
  });
  it("records the 25 and 50 percent milestones", async () => {
    await contributeTokens(4);
    await contributeTokens(4);
    await contributeTokens(2);

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      3,
      "The 25% and 50% milestone flags must both be set",
    );
  });
  it("rejects a contribution above the per-wallet limit", async () => {
    try {
      await contributeTokens(5);

      assert.fail("A contribution above 10% should have been rejected");
    } catch (error) {
      assert.strictEqual(
        error.error?.errorCode?.code,
        "ContributionTooBig",
        "The program must return the named ContributionTooBig error",
      );
    }

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      3,
      "A rejected contribution must not change milestone state",
    );
  });
  it("keeps reached milestone flags unchanged on later contributions", async () => {
    await contributeTokens(1);

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      3,
      "Already reached milestones must not be recorded twice",
    );
  });
  it("rejects multiple contributions above the cumulative wallet limit", async () => {
    const repeatContributor = await contributeTokens(4);

    try {
      await contributeTokens(1, repeatContributor);

      assert.fail("One wallet must not contribute more than 10% in total");
    } catch (error) {
      assert.strictEqual(
        error.error?.errorCode?.code,
        "MaximumContributionsReached",
        "The program must enforce the cumulative per-wallet limit",
      );
    }
  });
  it("records all three milestones at 75 percent", async () => {
    await contributeTokens(4);
    await contributeTokens(1);

    const fundraiserAccount =
      await program.account.fundraiser.fetch(fundraiser);

    assert.strictEqual(
      fundraiserAccount.milestonesFired,
      7,
      "The 25%, 50% and 75% milestone flags must all be set",
    );
  });
});
