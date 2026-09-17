import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { Fundraiser } from "../target/types/fundraiser";

describe("fundraiser — milestone events", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const TARGET = 12_000_000;
  const CONTRIBUTION = 1_000_000;

  let fundraiser: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;
  let mint: anchor.web3.PublicKey;
  let contributors: anchor.web3.Keypair[];
  let contributorAccounts: anchor.web3.PublicKey[];
  let contributorAtas: anchor.web3.PublicKey[];

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  const milestoneEventCount = async (signature: string): Promise<number> => {
    const transaction = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return (transaction?.meta?.logMessages ?? []).filter((line) =>
      line.includes("Program data:"),
    ).length;
  };

  const contribute = async (index: number): Promise<string> =>
    program.methods
      .contribute(new anchor.BN(CONTRIBUTION))
      .accountsPartial({
        contributor: contributors[index].publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount: contributorAccounts[index],
        contributorAta: contributorAtas[index],
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributors[index]])
      .rpc()
      .then(confirm);

  before(async () => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6,
    );
    fundraiser = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId,
    )[0];
    vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

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

    contributors = Array.from({ length: 10 }, () =>
      anchor.web3.Keypair.generate(),
    );
    contributorAccounts = contributors.map(
      (contributor) =>
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from("contributor"),
            fundraiser.toBuffer(),
            contributor.publicKey.toBuffer(),
          ],
          program.programId,
        )[0],
    );
    contributorAtas = [];

    for (const contributor of contributors) {
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
      contributorAtas.push(ata);
      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        ata,
        provider.publicKey,
        CONTRIBUTION,
      );
    }
  });

  it("does not fire below 25%, then fires at the exact boundary", async () => {
    await contribute(0);
    await contribute(1);
    let state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.milestonesFired, 0);

    const quarterTx = await contribute(2);
    assert.strictEqual(await milestoneEventCount(quarterTx), 1);
    state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.milestonesFired, 1);
  });

  it("fires the 50% and 75% marks as contributions cross them", async () => {
    await contribute(3);
    await contribute(4);
    const halfTx = await contribute(5);
    assert.strictEqual(await milestoneEventCount(halfTx), 1);
    let state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.milestonesFired, 3);

    await contribute(6);
    await contribute(7);
    const threeQuarterTx = await contribute(8);
    assert.strictEqual(await milestoneEventCount(threeQuarterTx), 1);
    state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.milestonesFired, 7);
  });

  it("does not replay a milestone on a later contribution", async () => {
    const repeatTx = await contribute(9);
    assert.strictEqual(await milestoneEventCount(repeatTx), 0);
    const state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(state.milestonesFired, 7);
  });
});
