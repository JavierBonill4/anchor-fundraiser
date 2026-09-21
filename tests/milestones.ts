import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { strict as assert } from "assert";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";

import { Fundraiser } from "../target/types/fundraiser";

describe("fundraiser milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as anchor.Wallet;

  const TARGET = 30_000_000; // 30 tokens, 6 decimals

  async function airdrop(pubkey: anchor.web3.PublicKey) {
    const signature = await provider.connection.requestAirdrop(
      pubkey,
      anchor.web3.LAMPORTS_PER_SOL
    );

    const blockhash = await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction({
      signature,
      ...blockhash,
    });
  }

  async function createCampaign() {
    const maker = anchor.web3.Keypair.generate();

    await airdrop(maker.publicKey);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    const fundraiser = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    )[0];

    const vault = getAssociatedTokenAddressSync(
      mint,
      fundraiser,
      true
    );

    await program.methods
      .initialize(new anchor.BN(TARGET), 7)
      .accountsPartial({
        maker: maker.publicKey,
        fundraiser,
        mintToRaise: mint,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    return {
      maker,
      mint,
      fundraiser,
      vault,
    };
  }

  async function contribute(
    mint: anchor.web3.PublicKey,
    fundraiser: anchor.web3.PublicKey,
    vault: anchor.web3.PublicKey,
    amount: number
  ) {
    const contributor = anchor.web3.Keypair.generate();

    await airdrop(contributor.publicKey);

    const contributorAta =
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        contributor.publicKey
      );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      contributorAta.address,
      wallet.payer,
      amount
    );

    const contributorAccount =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          fundraiser.toBuffer(),
          contributor.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

    await program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.publicKey,
        fundraiser,
        contributorAccount,
        contributorAta: contributorAta.address,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([contributor])
      .rpc();
  }

  it("fires the 25% milestone when the campaign reaches 25%", async () => {
    const campaign = await createCampaign();

    await contribute(
      campaign.mint,
      campaign.fundraiser,
      campaign.vault,
      3_000_000
    );

    await contribute(
      campaign.mint,
      campaign.fundraiser,
      campaign.vault,
      3_000_000
    );

    await contribute(
      campaign.mint,
      campaign.fundraiser,
      campaign.vault,
      1_500_000
    );

    const state =
      await program.account.fundraiser.fetch(campaign.fundraiser);

    assert.strictEqual(state.milestonesFired, 1);
  });

  it("fires exactly at 25%, but not one base unit below", async () => {
    const below = await createCampaign();

    await contribute(
      below.mint,
      below.fundraiser,
      below.vault,
      3_000_000
    );

    await contribute(
      below.mint,
      below.fundraiser,
      below.vault,
      3_000_000
    );

    await contribute(
      below.mint,
      below.fundraiser,
      below.vault,
      1_499_999
    );

    const belowState =
      await program.account.fundraiser.fetch(below.fundraiser);

    assert.strictEqual(
      belowState.milestonesFired,
      0,
      "25% milestone fired one base unit too early"
    );

    const exact = await createCampaign();

    await contribute(
      exact.mint,
      exact.fundraiser,
      exact.vault,
      3_000_000
    );

    await contribute(
      exact.mint,
      exact.fundraiser,
      exact.vault,
      3_000_000
    );

    await contribute(
      exact.mint,
      exact.fundraiser,
      exact.vault,
      1_500_000
    );

    const exactState =
      await program.account.fundraiser.fetch(exact.fundraiser);

    assert.strictEqual(
      exactState.milestonesFired,
      1,
      "25% milestone did not fire at the exact boundary"
    );
  });

  it("does not fire the 25% milestone twice", async () => {
    const campaign = await createCampaign();

    await contribute(
      campaign.mint,
      campaign.fundraiser,
      campaign.vault,
      3_000_000
    );

    await contribute(
      campaign.mint,
      campaign.fundraiser,
      campaign.vault,
      3_000_000
    );

    await contribute(
      campaign.mint,
      campaign.fundraiser,
      campaign.vault,
      1_500_000
    );

    let state =
      await program.account.fundraiser.fetch(campaign.fundraiser);

    assert.strictEqual(state.milestonesFired, 1);

    // Another contribution while still below 50%.
    await contribute(
      campaign.mint,
      campaign.fundraiser,
      campaign.vault,
      1_000_000
    );

    state =
      await program.account.fundraiser.fetch(campaign.fundraiser);

    assert.strictEqual(
      state.milestonesFired,
      1,
      "25% milestone was recorded more than once"
    );
  });
});