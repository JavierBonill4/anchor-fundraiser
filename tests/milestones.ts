import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import * as assert from "assert";

// This file is self-contained: its own mint, its own maker, its own set of
// contributors, so it never touches state that fundraiser.ts or the
// time-window tests depend on.
describe("fundraiser — milestone unlocks", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const maker = anchor.web3.Keypair.generate();

  // 40 whole tokens, 6 decimals -> 40_000_000 raw units.
  // Per-contributor cap is 10% of target = 4_000_000. 25% of target =
  // 10_000_000, so reaching it needs more than one contributor.
  const TARGET = 40_000_000;
  const QUARTER = TARGET / 4; // 10_000_000

  let mint: anchor.web3.PublicKey;
  let fundraiser: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block });
    return signature;
  };

  const contributorPda = (contributor: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), contributor.toBuffer()],
      program.programId
    )[0];

  // Creates a funded contributor keypair with its own ATA holding `funding`
  // raw units, ready to sign its own contribute() calls.
  const newContributor = async (funding: number) => {
    const kp = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(kp.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);
    const ata = (
      await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, mint, kp.publicKey)
    ).address;
    await mintTo(provider.connection, wallet.payer, mint, ata, provider.publicKey, funding);
    return { kp, ata };
  };

  const contribute = async (kp: anchor.web3.Keypair, ata: anchor.web3.PublicKey, amount: number) => {
    return program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: kp.publicKey,
        fundraiser,
        contributorAccount: contributorPda(kp.publicKey),
        contributorAta: ata,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([kp])
      .rpc({ skipPreflight: true })
      .then(confirm);
  };

  // Sends one contribution and reads back the raw program logs of that
  // transaction, decoding any MilestoneReached events found there. This is
  // more reliable in a local test validator than a websocket event
  // subscription, which is prone to timing flakiness here.
  const contributeAndCollectEvents = async (
    kp: anchor.web3.Keypair,
    ata: anchor.web3.PublicKey,
    amount: number
  ): Promise<any[]> => {
    const sig = await contribute(kp, ata, amount);
    const tx = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = tx?.meta?.logMessages ?? [];
    const events: any[] = [];
    const parser = new anchor.EventParser(program.programId, program.coder);
    for (const event of parser.parseLogs(logs)) {
      if (event.name === "MilestoneReached") {
        events.push(event.data);
      }
    }
    return events;
  };

  before(async () => {
    await provider.connection
      .requestAirdrop(maker.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    mint = await createMint(provider.connection, wallet.payer, provider.publicKey, provider.publicKey, 6);

    fundraiser = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    )[0];
    vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new anchor.BN(TARGET), 7)
      .accountsPartial({
        maker: maker.publicKey,
        fundraiser,
        mintToRaise: mint,
        vault,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      })
      .signers([maker])
      .rpc({ skipPreflight: true })
      .then(confirm);
  });

  it("does not fire any milestone while below the 25% mark", async () => {
    // A + B + C = 4,000,000 + 4,000,000 + 1,000,000 = 9,000,000 raw units,
    // one whole token short of the 10,000,000 (25%) boundary.
    const a = await newContributor(5_000_000);
    const b = await newContributor(5_000_000);
    const c = await newContributor(5_000_000);

    await contribute(a.kp, a.ata, 4_000_000);
    await contribute(b.kp, b.ata, 4_000_000);
    await contribute(c.kp, c.ata, 1_000_000);

    const state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(
      state.milestonesFired,
      0,
      "no milestone should fire below the 25% mark"
    );
  });

  it("fires the 25% milestone exactly when the mark is reached", async () => {
    const d = await newContributor(2_000_000);

    // Total goes from 9,000,000 to exactly 10,000,000 - precisely the
    // 25% boundary, not past it.
    await contribute(d.kp, d.ata, 1_000_000);

    const state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(
      state.milestonesFired & 1,
      1,
      "bit 0 (25%) should be set exactly at the boundary"
    );
  });

  it("does not re-fire the 25% milestone on a later contribution", async () => {
    const e = await newContributor(2_000_000);

    // Total goes from 10,000,000 to 11,000,000 - still inside the same
    // quarter. The bit is already set; this must not fire a duplicate event.
    const events = await contributeAndCollectEvents(e.kp, e.ata, 1_000_000);

    const state = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(
      state.milestonesFired,
      1,
      "milestones_fired must be unchanged (still just the 25% bit)"
    );
    assert.strictEqual(
      events.length,
      0,
      "a contribution within an already-fired quarter must not emit MilestoneReached"
    );
  });
});
