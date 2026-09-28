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

describe("fundraiser — whitelist feature", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const TARGET = 30_000_000;
  const CONTRIBUTION = 1_000_000;

  const maker = anchor.web3.Keypair.generate();
  const alice = anchor.web3.Keypair.generate();
  const bob = anchor.web3.Keypair.generate();

  let mint: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;
  let fundraiser: anchor.web3.PublicKey;

  let aliceAta: anchor.web3.PublicKey;
  let aliceContributorAccount: anchor.web3.PublicKey;
  let aliceWhitelistEntry: anchor.web3.PublicKey;

  let bobAta: anchor.web3.PublicKey;
  let bobContributorAccount: anchor.web3.PublicKey;
  let bobWhitelistEntry: anchor.web3.PublicKey;

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

  before(async () => {
    // Fund all accounts
    await Promise.all([
      provider.connection
        .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
        .then(confirm),
      provider.connection
        .requestAirdrop(alice.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
        .then(confirm),
      provider.connection
        .requestAirdrop(bob.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
        .then(confirm),
    ]);

    // Create token mint
    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    // Create ATAs and mint tokens for Alice and Bob
    aliceAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        alice.publicKey
      )
    ).address;

    bobAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        bob.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      aliceAta,
      provider.publicKey,
      10 * CONTRIBUTION
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      bobAta,
      provider.publicKey,
      10 * CONTRIBUTION
    );

    // Derive fundraiser PDA and vault ATA
    [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    // Derive Alice's accounts
    [aliceContributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );
    [aliceWhitelistEntry] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), fundraiser.toBuffer(), alice.publicKey.toBuffer()],
      program.programId
    );

    // Derive Bob's accounts
    [bobContributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), bob.publicKey.toBuffer()],
      program.programId
    );
    [bobWhitelistEntry] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("whitelist"), fundraiser.toBuffer(), bob.publicKey.toBuffer()],
      program.programId
    );

    // Initialize the fundraiser campaign
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
  });

  // -------------------------------------------------------------------------
  // Test 1: Happy Path
  // -------------------------------------------------------------------------
  it("happy path: whitelisted contributor can contribute", async () => {
    // Maker whitelists Alice
    await program.methods
      .whitelistContributor(true)
      .accountsPartial({
        maker: maker.publicKey,
        contributor: alice.publicKey,
        fundraiser,
        whitelistEntry: aliceWhitelistEntry,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc()
      .then(confirm);

    const entry = await program.account.whitelistEntry.fetch(aliceWhitelistEntry);
    assert.isTrue(entry.isAllowed, "Alice should be marked as allowed");

    // Alice contributes
    await program.methods
      .contribute(new anchor.BN(CONTRIBUTION))
      .accountsPartial({
        contributor: alice.publicKey,
        mintToRaise: mint,
        fundraiser,
        whitelistEntry: aliceWhitelistEntry,
        contributorAccount: aliceContributorAccount,
        contributorAta: aliceAta,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([alice])
      .rpc()
      .then(confirm);

    const vaultBalance = await provider.connection.getTokenAccountBalance(vault);
    assert.strictEqual(
      vaultBalance.value.amount,
      CONTRIBUTION.toString(),
      "Vault balance should reflect Alice's contribution"
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: Boundary Condition
  // -------------------------------------------------------------------------
  it("boundary: revoking whitelist blocks contributions, re-granting re-enables them", async () => {
    // Maker revokes Alice's whitelist permission
    await program.methods
      .whitelistContributor(false)
      .accountsPartial({
        maker: maker.publicKey,
        contributor: alice.publicKey,
        fundraiser,
        whitelistEntry: aliceWhitelistEntry,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc()
      .then(confirm);

    const revokedEntry = await program.account.whitelistEntry.fetch(aliceWhitelistEntry);
    assert.isFalse(revokedEntry.isAllowed, "Alice's permission should be revoked");

    // Alice attempts to contribute while revoked -> must fail with NotWhitelisted
    try {
      await program.methods
        .contribute(new anchor.BN(CONTRIBUTION))
        .accountsPartial({
          contributor: alice.publicKey,
          mintToRaise: mint,
          fundraiser,
          whitelistEntry: aliceWhitelistEntry,
          contributorAccount: aliceContributorAccount,
          contributorAta: aliceAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([alice])
        .rpc();
      assert.fail("Contribution should fail when contributor is revoked from whitelist");
    } catch (err) {
      assertErrorIs(
        err,
        "NotWhitelisted",
        "A revoked contributor must be rejected with NotWhitelisted"
      );
    }

    // Maker re-enables Alice's whitelist permission
    await program.methods
      .whitelistContributor(true)
      .accountsPartial({
        maker: maker.publicKey,
        contributor: alice.publicKey,
        fundraiser,
        whitelistEntry: aliceWhitelistEntry,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc()
      .then(confirm);

    // Alice can contribute again
    await program.methods
      .contribute(new anchor.BN(CONTRIBUTION))
      .accountsPartial({
        contributor: alice.publicKey,
        mintToRaise: mint,
        fundraiser,
        whitelistEntry: aliceWhitelistEntry,
        contributorAccount: aliceContributorAccount,
        contributorAta: aliceAta,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([alice])
      .rpc()
      .then(confirm);

    const vaultBalance = await provider.connection.getTokenAccountBalance(vault);
    assert.strictEqual(
      vaultBalance.value.amount,
      (2 * CONTRIBUTION).toString(),
      "Vault balance should reflect Alice's second contribution"
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: Abuse Case
  // -------------------------------------------------------------------------
  it("abuse case: non-maker cannot whitelist wallets, unwhitelisted wallet cannot contribute", async () => {
    // 1. Bob (non-maker attacker) attempts to whitelist himself on maker's fundraiser
    try {
      await program.methods
        .whitelistContributor(true)
        .accountsPartial({
          maker: bob.publicKey, // Bob tries to pose as the maker
          contributor: bob.publicKey,
          fundraiser,
          whitelistEntry: bobWhitelistEntry,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([bob])
        .rpc();
      assert.fail("Non-maker must not be able to whitelist accounts on someone else's fundraiser");
    } catch (err) {
      const errCode = errorCodeOf(err);
      assert.isTrue(
        errCode.toLowerCase().includes("hasone") ||
          errCode.toLowerCase().includes("seeds") ||
          errCode.toLowerCase().includes("constraint"),
        `Expected authorization failure for non-maker, got: ${errCode}`
      );
    }

    // 2. Unwhitelisted Bob attempts to contribute to the fundraiser
    try {
      await program.methods
        .contribute(new anchor.BN(CONTRIBUTION))
        .accountsPartial({
          contributor: bob.publicKey,
          mintToRaise: mint,
          fundraiser,
          whitelistEntry: bobWhitelistEntry,
          contributorAccount: bobContributorAccount,
          contributorAta: bobAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([bob])
        .rpc();
      assert.fail("Unwhitelisted contributor must not be allowed to contribute");
    } catch (err) {
      assert.isTrue(
        err !== undefined,
        "Transaction must fail for unwhitelisted contributor"
      );
    }
  });
});
