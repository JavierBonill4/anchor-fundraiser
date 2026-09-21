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

describe("milestone signals", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const TARGET = 30_000_000;
  const QUARTER = 7_500_000;

  const confirm = async (signature: string) => {
    const block = await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction({
      signature,
      ...block,
    });

    return signature;
  };

  const createCampaign = async () => {
    const maker = anchor.web3.Keypair.generate();

    await provider.connection
      .requestAirdrop(
        maker.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      )
      .then(confirm);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    const [fundraiser] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("fundraiser"),
          maker.publicKey.toBuffer(),
        ],
        program.programId
      );

    const vault = getAssociatedTokenAddressSync(
      mint,
      fundraiser,
      true
    );

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

    return { mint, fundraiser, vault };
  };

  const contribute = async (
    campaign: Awaited<ReturnType<typeof createCampaign>>,
    amount: number
  ) => {
    const contributor = anchor.web3.Keypair.generate();

    await provider.connection
      .requestAirdrop(
        contributor.publicKey,
        anchor.web3.LAMPORTS_PER_SOL
      )
      .then(confirm);

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
      amount
    );

    const [contributorAccount] =
      anchor.web3.PublicKey.findProgramAddressSync(
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
  };

  it("does not fire below 25%", async () => {
    const campaign = await createCampaign();

    await contribute(campaign, 3_000_000);
    await contribute(campaign, 3_000_000);
    await contribute(campaign, 1_499_999);

    const fundraiser =
      await program.account.fundraiser.fetch(
        campaign.fundraiser
      );

    assert.strictEqual(
      fundraiser.currentAmount.toNumber(),
      QUARTER - 1
    );

    assert.strictEqual(
      fundraiser.milestonesFired,
      0
    );
  });

  it("fires exactly at 25%", async () => {
    const campaign = await createCampaign();

    await contribute(campaign, 3_000_000);
    await contribute(campaign, 3_000_000);
    await contribute(campaign, 1_500_000);

    const fundraiser =
      await program.account.fundraiser.fetch(
        campaign.fundraiser
      );

    assert.strictEqual(
      fundraiser.currentAmount.toNumber(),
      QUARTER
    );

    assert.strictEqual(
      fundraiser.milestonesFired,
      1
    );
  });

  it("does not record the 25% milestone twice", async () => {
    const campaign = await createCampaign();

    await contribute(campaign, 3_000_000);
    await contribute(campaign, 3_000_000);
    await contribute(campaign, 1_500_000);

    let fundraiser =
      await program.account.fundraiser.fetch(
        campaign.fundraiser
      );

    assert.strictEqual(
      fundraiser.milestonesFired,
      1
    );

    await contribute(campaign, 1_000_000);

    fundraiser =
      await program.account.fundraiser.fetch(
        campaign.fundraiser
      );

    assert.strictEqual(
      fundraiser.milestonesFired,
      1
    );
  });
});
