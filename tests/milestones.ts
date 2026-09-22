import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert, AssertionError } from "chai";
import { Fundraiser } from "../target/types/fundraiser";

describe("fundraiser milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  const fund = async (recipient: anchor.web3.PublicKey) => {
    const signature = await provider.connection.requestAirdrop(
      recipient,
      anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature, "confirmed");
  };

  const openCampaign = async (target: anchor.BN): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await fund(maker.publicKey);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      null,
      0
    );
    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(target, 7)
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

    return { maker, mint, fundraiser, vault };
  };

  const contribute = async (
    campaign: Campaign,
    amount: number,
    contributor = anchor.web3.Keypair.generate()
  ) => {
    await fund(contributor.publicKey);

    const contributorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        campaign.mint,
        contributor.publicKey
      )
    ).address;
    await mintTo(
      provider.connection,
      wallet.payer,
      campaign.mint,
      contributorAta,
      provider.publicKey,
      10
    );

    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        campaign.fundraiser.toBuffer(),
        contributor.publicKey.toBuffer(),
      ],
      program.programId
    );

    await program.methods
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
      .rpc();

    return contributor;
  };

  it("records the 25% milestone when a contribution crosses it", async () => {
    const campaign = await openCampaign(new anchor.BN(40));

    await contribute(campaign, 4);
    await contribute(campaign, 4);
    await contribute(campaign, 4);

    const state = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(state.currentAmount.toNumber(), 12);
    assert.strictEqual(state.milestonesFired, 0b001);
  });

  it("fires at exactly 25%, but not one unit below", async () => {
    const campaign = await openCampaign(new anchor.BN(40));

    await contribute(campaign, 4);
    await contribute(campaign, 4);
    const lastContributor = await contribute(campaign, 1);

    const below = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(below.currentAmount.toNumber(), 9);
    assert.strictEqual(below.milestonesFired, 0);

    await contribute(campaign, 1, lastContributor);

    const boundary = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(boundary.currentAmount.toNumber(), 10);
    assert.strictEqual(boundary.milestonesFired, 0b001);
  });

  it("rejects an overflowing fundraiser target with Overflow", async () => {
    const campaign = await openCampaign(
      new anchor.BN("18446744073709551615")
    );

    try {
      await contribute(campaign, 1);
      assert.fail("expected the overflowing target calculation to fail");
    } catch (err: any) {
      if (err instanceof AssertionError) throw err;
      assert.strictEqual(err.error?.errorCode?.code, "Overflow");
    }
  });
});
