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

describe("milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const TARGET = 30_000_000;
  const DURATION = 7;

  let mint: anchor.web3.PublicKey;

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();

    await provider.connection.confirmTransaction({
      signature,
      ...block,
    });

    return signature;
  };

  const setupFundraiser = async () => {
    const maker = anchor.web3.Keypair.generate();

    await provider.connection
      .requestAirdrop(
        maker.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      )
      .then(confirm);

    const fundraiser =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("fundraiser"),
          maker.publicKey.toBuffer(),
        ],
        program.programId
      )[0];

    const vault = getAssociatedTokenAddressSync(
      mint,
      fundraiser,
      true
    );

    await program.methods
      .initialize(new anchor.BN(TARGET), DURATION)
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
      .rpc();

    return { fundraiser, vault };
  };

  const setupContributor = async (
    fundraiser: anchor.web3.PublicKey
  ) => {
    const contributor = anchor.web3.Keypair.generate();

    await provider.connection
      .requestAirdrop(
        contributor.publicKey,
        1 * anchor.web3.LAMPORTS_PER_SOL
      )
      .then(confirm);

    const contributorAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        contributor.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      contributorAta,
      provider.publicKey,
      3_000_000
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

    return {
      contributor,
      contributorAta,
      contributorAccount,
    };
  };

  const contribute = async (
    fundraiser: anchor.web3.PublicKey,
    vault: anchor.web3.PublicKey,
    contributor: {
      contributor: anchor.web3.Keypair;
      contributorAta: anchor.web3.PublicKey;
      contributorAccount: anchor.web3.PublicKey;
    },
    amount: number
  ) => {
    await program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.contributor.publicKey,
        fundraiser,
        contributorAccount: contributor.contributorAccount,
        contributorAta: contributor.contributorAta,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([contributor.contributor])
      .rpc();
  };

  before(async () => {
    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );
  });

  it("does not fire a milestone below 25%", async () => {
    const { fundraiser, vault } =
      await setupFundraiser();

    const contributor =
      await setupContributor(fundraiser);

    await contribute(
      fundraiser,
      vault,
      contributor,
      1_000_000
    );

    const account =
      await program.account.fundraiser.fetch(
        fundraiser
      );

    if (account.currentAmount.toNumber() !== 1_000_000) {
      throw new Error(
        `Expected current amount 1,000,000, got ${account.currentAmount.toNumber()}`
      );
    }

    if (account.milestonesFired !== 0) {
      throw new Error(
        `Expected no milestones below 25%, got ${account.milestonesFired}`
      );
    }
  });

  it("fires the 25% milestone at the exact boundary", async () => {
    const { fundraiser, vault } =
      await setupFundraiser();

    const contributor1 =
      await setupContributor(fundraiser);

    const contributor2 =
      await setupContributor(fundraiser);

    const contributor3 =
      await setupContributor(fundraiser);

    await contribute(
      fundraiser,
      vault,
      contributor1,
      3_000_000
    );

    await contribute(
      fundraiser,
      vault,
      contributor2,
      3_000_000
    );

    await contribute(
      fundraiser,
      vault,
      contributor3,
      1_500_000
    );

    const account =
      await program.account.fundraiser.fetch(
        fundraiser
      );

    if (account.currentAmount.toNumber() !== 7_500_000) {
      throw new Error(
        `Expected current amount 7,500,000, got ${account.currentAmount.toNumber()}`
      );
    }

    if (account.milestonesFired !== 1) {
      throw new Error(
        `Expected 25% milestone bitmask 1, got ${account.milestonesFired}`
      );
    }
  });

  it("does not fire the same milestone twice", async () => {
    const { fundraiser, vault } =
      await setupFundraiser();

    const contributor1 =
      await setupContributor(fundraiser);

    const contributor2 =
      await setupContributor(fundraiser);

    const contributor3 =
      await setupContributor(fundraiser);

    const contributor4 =
      await setupContributor(fundraiser);

    await contribute(
      fundraiser,
      vault,
      contributor1,
      3_000_000
    );

    await contribute(
      fundraiser,
      vault,
      contributor2,
      3_000_000
    );

    await contribute(
      fundraiser,
      vault,
      contributor3,
      1_500_000
    );

    await contribute(
      fundraiser,
      vault,
      contributor4,
      1_500_000
    );

    const account =
      await program.account.fundraiser.fetch(
        fundraiser
      );

    if (account.currentAmount.toNumber() !== 9_000_000) {
      throw new Error(
        `Expected current amount 9,000,000, got ${account.currentAmount.toNumber()}`
      );
    }

    if (account.milestonesFired !== 1) {
      throw new Error(
        `Expected only the 25% bit to remain set, got ${account.milestonesFired}`
      );
    }
  });

  it("tracks the 50% and 75% milestones", async () => {
    const { fundraiser, vault } =
      await setupFundraiser();

    const contributors = [];

    for (let i = 0; i < 8; i++) {
      contributors.push(
        await setupContributor(fundraiser)
      );
    }

    // 5 × 3,000,000 = 15,000,000 = 50%
    for (let i = 0; i < 5; i++) {
      await contribute(
        fundraiser,
        vault,
        contributors[i],
        3_000_000
      );
    }

    let account =
      await program.account.fundraiser.fetch(
        fundraiser
      );

    if (account.currentAmount.toNumber() !== 15_000_000) {
      throw new Error(
        `Expected current amount 15,000,000, got ${account.currentAmount.toNumber()}`
      );
    }

    // 1 = 25%, 2 = 50%
    if (account.milestonesFired !== 3) {
      throw new Error(
        `Expected 25% and 50% bits set (3), got ${account.milestonesFired}`
      );
    }

    // +7,500,000 = 22,500,000 = 75%
    await contribute(
      fundraiser,
      vault,
      contributors[5],
      3_000_000
    );

    await contribute(
      fundraiser,
      vault,
      contributors[6],
      3_000_000
    );

    await contribute(
      fundraiser,
      vault,
      contributors[7],
      1_500_000
    );

    account =
      await program.account.fundraiser.fetch(
        fundraiser
      );

    if (account.currentAmount.toNumber() !== 22_500_000) {
      throw new Error(
        `Expected current amount 22,500,000, got ${account.currentAmount.toNumber()}`
      );
    }

    // 1 = 25%, 2 = 50%, 4 = 75% → 7
    if (account.milestonesFired !== 7) {
      throw new Error(
        `Expected all three milestone bits set (7), got ${account.milestonesFired}`
      );
    }
  });
});