import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { assert, AssertionError } from "chai";

/**
 * Reward Token: `contribute` mints a matching amount of a second SPL token
 * (the "reward mint", created by `initialize` and owned by the fundraiser
 * PDA) straight to the contributor, 1:1, every time they contribute. It is a
 * receipt of having contributed, not a claim on the campaign succeeding — it
 * survives a refund. See ../README.md for the full design writeup, including
 * the reward-farming gap this leaves open (contribute-then-refund in a loop
 * mints rewards at zero net cost).
 *
 * These three tests are Checkpoint 6's minimum: a happy path that asserts
 * state, a boundary, and an abuse case that fails with a named error. The
 * abuse case is also the one that would pass silently without the feature's
 * `has_one = reward_mint @ FundraiserError::InvalidRewardMint` guard — no
 * guard, no rejection, so it is the test that proves the feature does
 * anything at all.
 */
describe("fundraiser — reward token", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const TARGET = 30_000_000; // 30 tokens at 6 decimals
  const CONTRIBUTION = 1_000_000; // 1 token
  const MAX_SINGLE_CONTRIBUTION = 3_000_000; // 10% of TARGET, the per-tx cap

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  const errorCodeOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;
    const text = `${err?.message ?? ""} ${JSON.stringify(err?.logs ?? [])}`;
    const match = text.match(/Error Code: (\w+)/);
    return match ? match[1] : text.slice(0, 300);
  };

  const assertErrorIs = (err: any, expected: string, why: string) => {
    const actual = errorCodeOf(err);
    assert.strictEqual(
      actual.toLowerCase(),
      expected.toLowerCase(),
      `${why} (expected ${expected}, got ${actual})`
    );
  };

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
    contributorAccount: anchor.web3.PublicKey;
    contributorAta: anchor.web3.PublicKey;
    rewardMint: anchor.web3.PublicKey;
    contributorRewardAta: anchor.web3.PublicKey;
  };

  /** A fresh seven-day campaign — the window is open for every test here. */
  const openCampaign = async (): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    const contributorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        wallet.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      contributorAta,
      provider.publicKey,
      10 * MAX_SINGLE_CONTRIBUTION
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), provider.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    const [rewardMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward"), fundraiser.toBuffer()],
      program.programId
    );
    const contributorRewardAta = getAssociatedTokenAddressSync(rewardMint, provider.publicKey);

    await program.methods
      .initialize(new anchor.BN(TARGET), 7)
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        vault,
        rewardMint,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc()
      .then(confirm);

    return {
      maker,
      mint,
      fundraiser,
      vault,
      contributorAccount,
      contributorAta,
      rewardMint,
      contributorRewardAta,
    };
  };

  /** `rewardMintOverride` lets the abuse test pass a mint that is not the
   *  campaign's own — everything else about the call stays legitimate. */
  const contribute = (
    c: Campaign,
    amount: number,
    rewardMintOverride?: anchor.web3.PublicKey
  ) => {
    const rewardMint = rewardMintOverride ?? c.rewardMint;
    const contributorRewardAta = rewardMintOverride
      ? getAssociatedTokenAddressSync(rewardMintOverride, provider.publicKey)
      : c.contributorRewardAta;

    return program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: provider.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: c.contributorAccount,
        contributorAta: c.contributorAta,
        vault: c.vault,
        rewardMint,
        contributorRewardAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  };

  const rewardBalance = async (ata: anchor.web3.PublicKey): Promise<string> =>
    (await provider.connection.getTokenAccountBalance(ata)).value.amount;

  it("mints a matching reward 1:1 with every contribution (happy path)", async () => {
    const campaign = await openCampaign();

    try {
      await contribute(campaign, CONTRIBUTION);
    } catch (err) {
      assert.fail(`the first contribution should be accepted, got ${errorCodeOf(err)}`);
    }
    assert.strictEqual(
      await rewardBalance(campaign.contributorRewardAta),
      String(CONTRIBUTION),
      "one contribution should mint exactly that many reward tokens"
    );

    try {
      await contribute(campaign, CONTRIBUTION);
    } catch (err) {
      assert.fail(`the second contribution should be accepted, got ${errorCodeOf(err)}`);
    }
    assert.strictEqual(
      await rewardBalance(campaign.contributorRewardAta),
      String(2 * CONTRIBUTION),
      "a second contribution should mint into the same reward account, on top of the first"
    );
  });

  it("mints exactly the reward at the maximum single contribution (boundary)", async () => {
    const campaign = await openCampaign();

    try {
      await contribute(campaign, MAX_SINGLE_CONTRIBUTION);
    } catch (err) {
      assert.fail(
        `a contribution at the 10% cap must still be accepted, got ${errorCodeOf(err)}`
      );
    }

    assert.strictEqual(
      await rewardBalance(campaign.contributorRewardAta),
      String(MAX_SINGLE_CONTRIBUTION),
      "the reward at the cap should equal the cap exactly, with no rounding"
    );
  });

  it("refuses a contribution when the reward mint does not match the fundraiser's (abuse)", async () => {
    const campaign = await openCampaign();

    // An unrelated mint the attacker fully controls — not the one `initialize`
    // created and stored on the fundraiser.
    const decoyRewardMint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    try {
      await contribute(campaign, CONTRIBUTION, decoyRewardMint);
      assert.fail("a contribution with a spoofed reward mint must be refused");
    } catch (err) {
      assertErrorIs(
        err,
        "InvalidRewardMint",
        "the reward mint must be checked against the one the fundraiser created"
      );
    }

    const vault = await provider.connection.getTokenAccountBalance(campaign.vault);
    assert.strictEqual(vault.value.amount, "0", "nothing should have reached the vault");
  });
});
