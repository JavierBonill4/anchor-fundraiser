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
import { assert } from "chai";

describe("fundraiser — milestone events", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const TARGET = 100_000_000;
  const ONE_TOKEN = 1_000_000;
  const MAX_CONTRIBUTION = 10_000_000;

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

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
      6,
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId,
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

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
      .rpc()
      .then(confirm);

    return { maker, mint, fundraiser, vault };
  };

  const contributeFromFreshContributor = async (
    campaign: Campaign,
    amount: number,
  ) => {
    const contributor = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(contributor.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const contributorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        campaign.mint,
        contributor.publicKey,
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      campaign.mint,
      contributorAta,
      provider.publicKey,
      amount,
    );

    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        campaign.fundraiser.toBuffer(),
        contributor.publicKey.toBuffer(),
      ],
      program.programId,
    );

    return program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.publicKey,
        mintToRaise: campaign.mint,
        fundraiser: campaign.fundraiser,
        contributorAccount,
        contributorAta,
        vault: campaign.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor])
      .rpc()
      .then(confirm);
  };

  const milestones = async (
    fundraiser: anchor.web3.PublicKey,
  ): Promise<number> => {
    const account = await program.account.fundraiser.fetch(fundraiser);
    return account.milestonesFired;
  };

  it("does not fire before 25%, then fires exactly at the 25% boundary", async () => {
    const campaign = await openCampaign();

    await contributeFromFreshContributor(campaign, MAX_CONTRIBUTION);
    await contributeFromFreshContributor(campaign, MAX_CONTRIBUTION);
    await contributeFromFreshContributor(campaign, 4 * ONE_TOKEN);

    assert.strictEqual(
      await milestones(campaign.fundraiser),
      0,
      "24% should not fire a milestone",
    );

    await contributeFromFreshContributor(campaign, ONE_TOKEN);

    assert.strictEqual(
      await milestones(campaign.fundraiser),
      1,
      "25% should set only the first bit",
    );
  });

  it("records each milestone once and keeps milestones one-way", async () => {
    const campaign = await openCampaign();

    await contributeFromFreshContributor(campaign, MAX_CONTRIBUTION);
    await contributeFromFreshContributor(campaign, MAX_CONTRIBUTION);
    await contributeFromFreshContributor(campaign, 5 * ONE_TOKEN);
    assert.strictEqual(
      await milestones(campaign.fundraiser),
      1,
      "25% should fire once",
    );

    await contributeFromFreshContributor(campaign, MAX_CONTRIBUTION);
    assert.strictEqual(
      await milestones(campaign.fundraiser),
      1,
      "35% should not re-fire 25%",
    );

    await contributeFromFreshContributor(campaign, MAX_CONTRIBUTION);
    await contributeFromFreshContributor(campaign, 5 * ONE_TOKEN);
    assert.strictEqual(
      await milestones(campaign.fundraiser),
      3,
      "50% should add the second bit",
    );

    await contributeFromFreshContributor(campaign, MAX_CONTRIBUTION);
    await contributeFromFreshContributor(campaign, MAX_CONTRIBUTION);
    await contributeFromFreshContributor(campaign, 5 * ONE_TOKEN);
    assert.strictEqual(
      await milestones(campaign.fundraiser),
      7,
      "75% should add the third bit",
    );
  });
});
