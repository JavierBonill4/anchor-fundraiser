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

describe("configurable contribution cap", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;
  const target = 40_000_000;

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  type Contributor = {
    keypair: anchor.web3.Keypair;
    account: anchor.web3.PublicKey;
    ata: anchor.web3.PublicKey;
  };

  const fund = async (recipient: anchor.web3.PublicKey) => {
    const signature = await provider.connection.requestAirdrop(
      recipient,
      anchor.web3.LAMPORTS_PER_SOL,
    );
    await provider.connection.confirmTransaction(signature, "confirmed");
  };

  const expectError = async (
    operation: () => Promise<unknown>,
    expected: string,
  ) => {
    try {
      await operation();
      assert.fail(`expected ${expected}`);
    } catch (error: any) {
      if (error instanceof AssertionError) throw error;
      const code = error?.error?.errorCode?.code;
      assert.strictEqual(code, expected);
    }
  };

  const createCampaign = async (): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await fund(maker.publicKey);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      null,
      6,
    );
    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId,
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new anchor.BN(target), 7)
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

  const createContributor = async (
    campaign: Campaign,
    tokenAmount: number,
  ): Promise<Contributor> => {
    const keypair = anchor.web3.Keypair.generate();
    await fund(keypair.publicKey);

    const ata = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        campaign.mint,
        keypair.publicKey,
      )
    ).address;
    await mintTo(
      provider.connection,
      wallet.payer,
      campaign.mint,
      ata,
      provider.publicKey,
      tokenAmount,
    );

    const [account] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        campaign.fundraiser.toBuffer(),
        keypair.publicKey.toBuffer(),
      ],
      program.programId,
    );

    return { keypair, account, ata };
  };

  const setCap = (
    campaign: Campaign,
    maker: anchor.web3.Keypair,
    percentage: number,
  ) =>
    program.methods
      .setContributionCap(percentage)
      .accountsPartial({
        maker: maker.publicKey,
        fundraiser: campaign.fundraiser,
      })
      .signers([maker])
      .rpc();

  const contribute = (
    campaign: Campaign,
    contributor: Contributor,
    amount: number,
  ) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.keypair.publicKey,
        mintToRaise: campaign.mint,
        fundraiser: campaign.fundraiser,
        contributorAccount: contributor.account,
        contributorAta: contributor.ata,
        vault: campaign.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor.keypair])
      .rpc();

  it("lets the maker lower the cap before contributions begin", async () => {
    const campaign = await createCampaign();

    let account = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(account.contributionCapPercentage, 10);
    assert.isFalse(account.contributionCapLocked);

    await setCap(campaign, campaign.maker, 5);

    account = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(account.contributionCapPercentage, 5);
    assert.isFalse(account.contributionCapLocked);
  });

  it("accepts the exact cap and rejects one raw unit above it", async () => {
    const campaign = await createCampaign();
    await setCap(campaign, campaign.maker, 5);

    const exactCap = (target * 5) / 100;
    const accepted = await createContributor(campaign, exactCap);
    await contribute(campaign, accepted, exactCap);

    const vault = await provider.connection.getTokenAccountBalance(
      campaign.vault,
    );
    assert.strictEqual(vault.value.amount, String(exactCap));

    const aboveCap = await createContributor(campaign, exactCap + 1);
    await expectError(
      () => contribute(campaign, aboveCap, exactCap + 1),
      "ContributionTooBig",
    );

    const unchangedVault = await provider.connection.getTokenAccountBalance(
      campaign.vault,
    );
    assert.strictEqual(unchangedVault.value.amount, String(exactCap));
  });

  it("rejects a cap update from anyone except the maker", async () => {
    const campaign = await createCampaign();
    const attacker = anchor.web3.Keypair.generate();
    await fund(attacker.publicKey);

    await expectError(() => setCap(campaign, attacker, 5), "UnauthorizedMaker");

    const account = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(account.contributionCapPercentage, 10);
  });

  it("rejects percentages outside the supported range", async () => {
    const campaign = await createCampaign();

    await expectError(
      () => setCap(campaign, campaign.maker, 0),
      "InvalidContributionCap",
    );
    await expectError(
      () => setCap(campaign, campaign.maker, 11),
      "InvalidContributionCap",
    );

    const account = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(account.contributionCapPercentage, 10);
  });

  it("locks the cap after the first contribution", async () => {
    const campaign = await createCampaign();
    await setCap(campaign, campaign.maker, 5);

    const contributor = await createContributor(campaign, 1_000_000);
    await contribute(campaign, contributor, 1_000_000);

    await expectError(
      () => setCap(campaign, campaign.maker, 4),
      "ContributionCapLocked",
    );

    const account = await program.account.fundraiser.fetch(campaign.fundraiser);
    assert.strictEqual(account.contributionCapPercentage, 5);
    assert.isTrue(account.contributionCapLocked);
  });
});
