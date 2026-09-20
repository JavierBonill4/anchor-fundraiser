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

// Contributors who arrive before 50% may claim one Metaplex NFT.
describe("fundraiser — early-investor NFT", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const TOKEN_METADATA_PROGRAM_ID = new anchor.web3.PublicKey(
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  );

  // Five maximum-sized contributions reach exactly 50%.
  const ONE_TOKEN = 1_000_000;
  const TARGET = 10_000_000;

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
      `${why} (expected ${expected}, got ${actual})`,
    );
  };

  /** Reads just the name/symbol out of a Metaplex Metadata account. */
  const decodeNameAndSymbol = (
    data: Buffer,
  ): { name: string; symbol: string } => {
    let offset = 1 + 32 + 32; // key + update_authority + mint
    const nameLen = data.readUInt32LE(offset);
    offset += 4;
    const name = data
      .slice(offset, offset + nameLen)
      .toString("utf8")
      .replace(/\0+$/, "");
    offset += nameLen;
    const symbolLen = data.readUInt32LE(offset);
    offset += 4;
    const symbol = data
      .slice(offset, offset + symbolLen)
      .toString("utf8")
      .replace(/\0+$/, "");
    return { name, symbol };
  };

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  const openCampaign = async (
    target = new anchor.BN(TARGET),
  ): Promise<Campaign> => {
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
      .rpc()
      .then(confirm);

    return { maker, mint, fundraiser, vault };
  };

  /** A funded keypair holding ONE_TOKEN of `mint`, ready to contribute. */
  const makeContributor = async (mint: anchor.web3.PublicKey) => {
    const contributor = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(contributor.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const ata = (
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
      ata,
      provider.publicKey,
      ONE_TOKEN,
    );

    return { keypair: contributor, ata };
  };

  const contributorPda = (
    fundraiser: anchor.web3.PublicKey,
    contributor: anchor.web3.PublicKey,
  ) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        fundraiser.toBuffer(),
        contributor.toBuffer(),
      ],
      program.programId,
    )[0];

  const contribute = (
    c: Campaign,
    contributor: anchor.web3.Keypair,
    contributorAta: anchor.web3.PublicKey,
  ) =>
    program.methods
      .contribute(new anchor.BN(ONE_TOKEN))
      .accountsPartial({
        contributor: contributor.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: contributorPda(c.fundraiser, contributor.publicKey),
        contributorAta,
        vault: c.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor])
      .rpc();

  const claimAccounts = (c: Campaign, contributor: anchor.web3.PublicKey) => {
    const [nftAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("early-investor-authority"), c.fundraiser.toBuffer()],
      program.programId,
    );
    const [nftMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("early-investor-mint"),
        c.fundraiser.toBuffer(),
        contributor.toBuffer(),
      ],
      program.programId,
    );
    const [metadata] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        nftMint.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    );
    const [masterEdition] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        nftMint.toBuffer(),
        Buffer.from("edition"),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    );
    const nftTokenAccount = getAssociatedTokenAddressSync(nftMint, contributor);

    return { nftAuthority, nftMint, metadata, masterEdition, nftTokenAccount };
  };

  const claim = (c: Campaign, contributor: anchor.web3.Keypair) => {
    const accounts = claimAccounts(c, contributor.publicKey);
    return program.methods
      .claimEarlyInvestorNft()
      .accountsPartial({
        contributor: contributor.publicKey,
        fundraiser: c.fundraiser,
        contributorAccount: contributorPda(c.fundraiser, contributor.publicKey),
        nftAuthority: accounts.nftAuthority,
        nftMint: accounts.nftMint,
        nftTokenAccount: accounts.nftTokenAccount,
        metadata: accounts.metadata,
        masterEdition: accounts.masterEdition,
        tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([contributor])
      .rpc();
  };

  it("flags a contributor who shows up while the fundraiser is under 50%, and lets them claim a real Metaplex NFT", async () => {
    const campaign = await openCampaign();
    const early = await makeContributor(campaign.mint);

    try {
      await contribute(campaign, early.keypair, early.ata);
    } catch (err) {
      assert.fail(
        `setup: the contribution was rejected with ${errorCodeOf(err)}`,
      );
    }

    const contributorAccount = await program.account.contributor.fetch(
      contributorPda(campaign.fundraiser, early.keypair.publicKey),
    );
    assert.isTrue(
      contributorAccount.isEarlyInvestor,
      "a contributor at 0% must be flagged as early",
    );
    assert.isFalse(
      contributorAccount.nftClaimed,
      "nothing has been claimed yet",
    );

    try {
      await claim(campaign, early.keypair);
    } catch (err) {
      assert.fail(
        `the claim should have succeeded, but was rejected with ${errorCodeOf(err)}`,
      );
    }

    const { nftMint, nftTokenAccount, metadata } = claimAccounts(
      campaign,
      early.keypair.publicKey,
    );

    const mintInfo = await provider.connection.getTokenSupply(nftMint);
    assert.strictEqual(
      mintInfo.value.amount,
      "1",
      "the NFT mint must have a supply of exactly one",
    );
    assert.strictEqual(
      mintInfo.value.decimals,
      0,
      "an NFT mint has zero decimals",
    );

    const tokenBalance =
      await provider.connection.getTokenAccountBalance(nftTokenAccount);
    assert.strictEqual(
      tokenBalance.value.amount,
      "1",
      "the contributor must hold the NFT",
    );

    const metadataAccount = await provider.connection.getAccountInfo(metadata);
    assert.isNotNull(metadataAccount, "the metadata account must exist");
    const { name, symbol } = decodeNameAndSymbol(metadataAccount!.data);
    assert.strictEqual(name, "Early Investor");
    assert.strictEqual(symbol, "EARLY");

    const claimedAccount = await program.account.contributor.fetch(
      contributorPda(campaign.fundraiser, early.keypair.publicKey),
    );
    assert.isTrue(
      claimedAccount.nftClaimed,
      "nft_claimed must be set after the claim",
    );
  });

  it("cannot be claimed twice by the same contributor", async () => {
    const campaign = await openCampaign();
    const early = await makeContributor(campaign.mint);

    await contribute(campaign, early.keypair, early.ata);
    await claim(campaign, early.keypair);

    try {
      await claim(campaign, early.keypair);
      assert.fail("a second claim by the same contributor must be refused");
    } catch (err) {
      assertErrorIs(
        err,
        "NftAlreadyClaimed",
        "the second claim should be refused",
      );
    }
  });

  it("refuses a contributor who arrives exactly at the 50% mark, not before it", async () => {
    const campaign = await openCampaign();

    // The fifth contributor starts below 50%; the sixth starts at 50%.
    let lastEarly: {
      keypair: anchor.web3.Keypair;
      ata: anchor.web3.PublicKey;
    } | null = null;
    for (let i = 0; i < 5; i++) {
      const c = await makeContributor(campaign.mint);
      await contribute(campaign, c.keypair, c.ata);
      lastEarly = c;
    }

    const fundraiserAfterFive = await program.account.fundraiser.fetch(
      campaign.fundraiser,
    );
    assert.strictEqual(
      fundraiserAfterFive.currentAmount.toNumber(),
      TARGET / 2,
      "five max contributions should land exactly on the 50% mark",
    );

    const lastEarlyAccount = await program.account.contributor.fetch(
      contributorPda(campaign.fundraiser, lastEarly!.keypair.publicKey),
    );
    assert.isTrue(
      lastEarlyAccount.isEarlyInvestor,
      "the fifth contributor arrived while still under 50% and must qualify",
    );

    const late = await makeContributor(campaign.mint);
    await contribute(campaign, late.keypair, late.ata);

    const lateAccount = await program.account.contributor.fetch(
      contributorPda(campaign.fundraiser, late.keypair.publicKey),
    );
    assert.isFalse(
      lateAccount.isEarlyInvestor,
      "a contributor arriving exactly at 50% must not be flagged as early",
    );

    try {
      await claim(campaign, late.keypair);
      assert.fail(
        "a non-qualifying contributor must not be able to claim the NFT",
      );
    } catch (err) {
      assertErrorIs(err, "NotEarlyInvestor", "the claim should be refused");
    }
  });

  it("returns Overflow when contribution-limit arithmetic cannot fit in u64", async () => {
    const campaign = await openCampaign(new anchor.BN("18446744073709551615"));
    const contributor = await makeContributor(campaign.mint);

    try {
      await contribute(campaign, contributor.keypair, contributor.ata);
      assert.fail("overflowing contribution-limit arithmetic must be refused");
    } catch (err) {
      assertErrorIs(err, "Overflow", "the arithmetic failure must be named");
    }
  });
});
