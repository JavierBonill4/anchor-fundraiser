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
import { assert } from "chai";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";

describe("milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const maker = anchor.web3.Keypair.generate();
  const alice = anchor.web3.Keypair.generate();
  const bob = anchor.web3.Keypair.generate();
  const cara = anchor.web3.Keypair.generate();
  const dan = anchor.web3.Keypair.generate();

  const TARGET = new anchor.BN(30_000_000); // 30 tokens, 6 decimals
  const MAX_ONE = new anchor.BN(3_000_000); // 10% cap
  const EXACT_QUARTER = new anchor.BN(1_500_000); // 5% — used to land on 25%
  const DURATION_DAYS = 7;

  let mint: anchor.web3.PublicKey;
  let fundraiser: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  const airdrop = async (pk: anchor.web3.PublicKey) => {
    await provider.connection
      .requestAirdrop(pk, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);
  };

  const contributorPda = (who: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), who.toBuffer()],
      program.programId
    )[0];

  const ataOf = async (who: anchor.web3.PublicKey) =>
    (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        who
      )
    ).address;

  const contribute = async (
    who: anchor.web3.Keypair,
    amount: anchor.BN
  ) => {
    const contributorAta = await ataOf(who.publicKey);
    await program.methods
      .contribute(amount)
      .accountsPartial({
        contributor: who.publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount: contributorPda(who.publicKey),
        contributorAta,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([who])
      .rpc()
      .then(confirm);
  };

  before(async () => {
    await airdrop(maker.publicKey);
    await airdrop(alice.publicKey);
    await airdrop(bob.publicKey);
    await airdrop(cara.publicKey);
    await airdrop(dan.publicKey);

    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    for (const who of [alice, bob, cara, dan]) {
      const ata = await ataOf(who.publicKey);
      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        ata,
        provider.publicKey,
        10_000_000
      );
    }

    fundraiser = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    )[0];
    vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(TARGET, DURATION_DAYS)
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
      .rpc()
      .then(confirm);
  });

  it("does not fire a milestone below 25%", async () => {
    await contribute(alice, MAX_ONE); // 10%

    const account = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(account.milestonesFired, 0);
    assert.strictEqual(account.currentAmount.toNumber(), 3_000_000);
  });

  it("sets bit 0 when the vault lands exactly on 25%", async () => {
    await contribute(bob, MAX_ONE); // 20% total
    let account = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(account.milestonesFired, 0);

    await contribute(cara, EXACT_QUARTER); // 25% total

    account = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(account.currentAmount.toNumber(), 7_500_000);
    assert.strictEqual(account.milestonesFired, 1); // 0b001
  });

  it("does not re-fire inside the same quarter", async () => {
    await contribute(dan, EXACT_QUARTER); // 30% total — still below 50%

    const account = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(account.currentAmount.toNumber(), 9_000_000);
    assert.strictEqual(account.milestonesFired, 1);
  });
});