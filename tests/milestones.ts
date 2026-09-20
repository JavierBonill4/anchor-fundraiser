import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { assert } from "chai";

// Milestones: 25% / 50% / 75% of the target, one bit each in milestones_fired.
// Runs against the local validator (no clock tricks needed: milestones are
// triggered by amounts, not time).
describe("fundraiser — milestones", () => {
  // Own provider + program, so a bankrun suite in another file that swaps the
  // global provider cannot leak into these tests.
  const provider = anchor.AnchorProvider.env();
  const program = new Program<Fundraiser>(
    (anchor.workspace.Fundraiser as Program<Fundraiser>).idl,
    provider
  );
  const payer = (provider.wallet as NodeWallet).payer;

  const DECIMALS = 6;
  const TOKEN = 10 ** DECIMALS; // 1 whole token in raw units
  const TARGET = 30 * TOKEN; // 25% = 7.5 tokens, max 3 tokens per wallet
  const DURATION_DAYS = 7;

  let mint: PublicKey;

  // ---------- helpers ----------

  const fundSol = async (to: PublicKey, sol = 0.2) => {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: to,
        lamports: sol * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx);
  };

  type Campaign = { fundraiser: PublicKey; vault: PublicKey };

  // One maker = one fundraiser PDA, so every campaign gets a fresh maker.
  const newCampaign = async (target = TARGET): Promise<Campaign> => {
    const maker = Keypair.generate();
    await fundSol(maker.publicKey);

    const [fundraiser] = PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    await program.methods
      .initialize(new BN(target), DURATION_DAYS)
      .accountsPartial({
        maker: maker.publicKey,
        mintToRaise: mint,
        fundraiser,
        vault,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    return { fundraiser, vault };
  };

  // A wallet with SOL for rent and some tokens to contribute.
  const newContributor = async (tokens = 10): Promise<Keypair> => {
    const c = Keypair.generate();
    await fundSol(c.publicKey);
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      c.publicKey
    );
    await mintTo(provider.connection, payer, mint, ata.address, payer, tokens * TOKEN);
    return c;
  };

  const contribute = async (camp: Campaign, c: Keypair, rawAmount: number) => {
    const [contributorAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), camp.fundraiser.toBuffer(), c.publicKey.toBuffer()],
      program.programId
    );
    await program.methods
      .contribute(new BN(rawAmount))
      .accountsPartial({
        contributor: c.publicKey,
        mintToRaise: mint,
        fundraiser: camp.fundraiser,
        contributorAccount,
        contributorAta: getAssociatedTokenAddressSync(mint, c.publicKey),
        vault: camp.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([c])
      .rpc();
  };

  // n fresh wallets, each contributing rawAmount.
  const contributeMany = async (camp: Campaign, n: number, rawAmount: number) => {
    for (let i = 0; i < n; i++) {
      await contribute(camp, await newContributor(), rawAmount);
    }
  };

  const state = (camp: Campaign) => program.account.fundraiser.fetch(camp.fundraiser);

  // Pull the Anchor error code out of whatever the client threw.
  const errorCode = (err: any): string => {
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;
    const logs: string[] = err?.logs ?? err?.transactionLogs ?? [];
    const line = logs.find((l) => l.includes("Error Code:"));
    return line ? line.split("Error Code: ")[1].split(".")[0] : String(err);
  };

  // ---------- setup ----------

  before(async () => {
    mint = await createMint(provider.connection, payer, payer.publicKey, null, DECIMALS);
  });

  // ---------- tests ----------

  it("happy path: fires 25%, then 50%, and records it on-chain", async () => {
    const camp = await newCampaign();

    await contributeMany(camp, 3, 3 * TOKEN); // 9 / 30 = 30%
    let f = await state(camp);
    assert.strictEqual(f.currentAmount.toNumber(), 9 * TOKEN);
    assert.strictEqual(f.milestonesFired, 0b001, "only the 25% bit");

    await contributeMany(camp, 2, 3 * TOKEN); // 15 / 30 = 50%
    f = await state(camp);
    assert.strictEqual(f.currentAmount.toNumber(), 15 * TOKEN);
    assert.strictEqual(f.milestonesFired, 0b011, "25% and 50% bits");
  });

  it("boundary: one raw unit below 25% fires nothing", async () => {
    const camp = await newCampaign();

    await contributeMany(camp, 2, 3 * TOKEN); // 6 tokens
    await contribute(camp, await newContributor(), 1_499_999); // total 7_499_999

    const f = await state(camp);
    assert.strictEqual(f.currentAmount.toNumber(), 7_499_999);
    assert.strictEqual(f.milestonesFired, 0, "just under 25% must not fire");
  });

  it("boundary: exactly 25% fires the first milestone", async () => {
    const camp = await newCampaign();

    await contributeMany(camp, 2, 3 * TOKEN); // 6 tokens
    await contribute(camp, await newContributor(), 1_500_000); // total 7_500_000

    const f = await state(camp);
    assert.strictEqual(f.currentAmount.toNumber(), 7_500_000);
    assert.strictEqual(f.milestonesFired, 0b001, "exactly 25% must fire");
  });

  it("abuse: a single whale cannot push a milestone past the per-wallet cap", async () => {
    const camp = await newCampaign();
    const whale = await newContributor(20);

    await contribute(camp, whale, 3 * TOKEN); // at the 10% cap

    try {
      await contribute(camp, whale, 1 * TOKEN);
      assert.fail("the whale's 4th token should have been rejected");
    } catch (err) {
      assert.strictEqual(errorCode(err), "MaximumContributionsReached");
    }

    const f = await state(camp);
    assert.strictEqual(f.currentAmount.toNumber(), 3 * TOKEN, "rejected tx moved nothing");
    assert.strictEqual(f.milestonesFired, 0, "no milestone from a capped whale");
  });

  it("idempotent: a later contribution does not re-fire or clear 25%", async () => {
    const camp = await newCampaign();

    await contributeMany(camp, 3, 3 * TOKEN); // 30%
    assert.strictEqual((await state(camp)).milestonesFired, 0b001);

    await contributeMany(camp, 1, 3 * TOKEN); // 40%, still under 50%
    const f = await state(camp);
    assert.strictEqual(f.currentAmount.toNumber(), 12 * TOKEN);
    assert.strictEqual(f.milestonesFired, 0b001, "unchanged at 40%");
  });

  it("caps at 75%: hitting 100% sets all three bits and nothing more", async () => {
    const camp = await newCampaign();

    await contributeMany(camp, 10, 3 * TOKEN); // 30 / 30 = 100%

    const f = await state(camp);
    assert.strictEqual(f.currentAmount.toNumber(), TARGET);
    assert.strictEqual(f.milestonesFired, 0b111, "25/50/75 set, no 4th bit");
  });
});