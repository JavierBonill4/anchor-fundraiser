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

/**
 * Milestone events at a quarter, a half and three quarters of the target.
 *
 * Every test asserts on two things: the bit on the account (which is what makes a
 * milestone permanent) and the event in the transaction logs (which is what a front
 * end actually hears). A test that only checked one of them would pass with half the
 * feature deleted.
 */
describe("fundraiser — milestones", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const DECIMALS = 6;
  const TOKEN = 10 ** DECIMALS;
  const TARGET = 30 * TOKEN;
  /** `contribute` caps any one contributor at 10% of the target. */
  const CAP = TARGET / 10;

  const QUARTER = 0b001;
  const HALF = 0b010;
  const THREE_QUARTERS = 0b100;

  const confirm = async (signature: string): Promise<string> => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...block }, "confirmed");
    return signature;
  };

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
  };

  let campaign: Campaign;

  /** A fresh campaign per test, so the milestone flags start clean every time. */
  const openCampaign = async (): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      DECIMALS
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

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

    return { maker, mint, fundraiser, vault };
  };

  /**
   * A funded contributor.
   *
   * The 10% cap is per person, so reaching a milestone at all takes several of
   * them — a quarter of the target is three contributors' worth at minimum.
   */
  const newContributor = async (): Promise<anchor.web3.Keypair> => {
    const kp = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(kp.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const ata = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        campaign.mint,
        kp.publicKey
      )
    ).address;

    await mintTo(provider.connection, wallet.payer, campaign.mint, ata, provider.publicKey, CAP);
    return kp;
  };

  /** Contributes and returns whatever `MilestoneReached` events the transaction emitted. */
  const contribute = async (
    contributor: anchor.web3.Keypair,
    amount: number
  ): Promise<{ quarter: number; currentAmount: string }[]> => {
    const contributorAta = getAssociatedTokenAddressSync(campaign.mint, contributor.publicKey);
    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        campaign.fundraiser.toBuffer(),
        contributor.publicKey.toBuffer(),
      ],
      program.programId
    );

    const signature = await program.methods
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
      .rpc()
      .then(confirm);

    // Read the events back out of the transaction rather than subscribing. A
    // websocket listener races the assertion; the logs are already there.
    const tx = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const parser = new anchor.EventParser(program.programId, program.coder);

    const events: { quarter: number; currentAmount: string }[] = [];
    for (const event of parser.parseLogs(tx!.meta!.logMessages!)) {
      if (event.name.toLowerCase() === "milestonereached") {
        events.push({
          quarter: (event.data as any).quarter as number,
          currentAmount: (event.data as any).currentAmount.toString(),
        });
      }
    }
    return events;
  };

  /** Contributes `amount` from a brand new person, since one person is capped at 10%. */
  const contributeFromSomeoneNew = async (amount: number) => contribute(await newContributor(), amount);

  const flags = async (): Promise<number> =>
    (await program.account.fundraiser.fetch(campaign.fundraiser)).milestonesFired;

  beforeEach(async () => {
    campaign = await openCampaign();
  });

  // ------------------------------------------------------------------

  it("fires nothing below the first mark", async () => {
    // 20% of the target, from two people.
    await contributeFromSomeoneNew(CAP);
    const events = await contributeFromSomeoneNew(CAP);

    assert.deepStrictEqual(events, [], "no milestone should have been announced");
    assert.strictEqual(await flags(), 0, "no milestone bit should be set");
  });

  it("fires the quarter mark exactly on the boundary", async () => {
    // 7.5 tokens is exactly 25% of 30.
    await contributeFromSomeoneNew(2.5 * TOKEN);
    await contributeFromSomeoneNew(2.5 * TOKEN);
    const events = await contributeFromSomeoneNew(2.5 * TOKEN);

    assert.strictEqual(events.length, 1, "exactly one milestone should fire");
    assert.strictEqual(events[0].quarter, 1, "it should be the quarter mark");
    assert.strictEqual(events[0].currentAmount, String(7.5 * TOKEN));
    assert.strictEqual(await flags(), QUARTER);
  });

  it("does not fire one unit below the boundary", async () => {
    // 7,499,999 raw units — one short of a quarter.
    await contributeFromSomeoneNew(2.5 * TOKEN);
    await contributeFromSomeoneNew(2.5 * TOKEN);
    const events = await contributeFromSomeoneNew(2.5 * TOKEN - 1);

    assert.deepStrictEqual(events, [], "one unit short is still short");
    assert.strictEqual(await flags(), 0);
  });

  it("fires a mark that a contribution jumped past", async () => {
    // 20% of the target, then a contribution that lands on 30%. The vault is never
    // observed at exactly 25%, and the milestone still has to fire.
    await contributeFromSomeoneNew(CAP);
    await contributeFromSomeoneNew(CAP);
    const events = await contributeFromSomeoneNew(3 * TOKEN);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].quarter, 1);
    assert.strictEqual(events[0].currentAmount, String(9 * TOKEN), "fired at 30%, not at 25%");
    assert.strictEqual(await flags(), QUARTER);
  });

  it("announces each mark once and only once", async () => {
    await contributeFromSomeoneNew(CAP);
    await contributeFromSomeoneNew(CAP);
    await contributeFromSomeoneNew(CAP); // 30% — quarter fires here

    // Two more contributions inside the same quarter. Nothing new to announce.
    const third = await contributeFromSomeoneNew(CAP); // 40%
    const fourth = await contributeFromSomeoneNew(1 * TOKEN); // ~43%

    assert.deepStrictEqual(third, [], "still below the half, so nothing fires");
    assert.deepStrictEqual(fourth, [], "and the quarter must not fire a second time");
    assert.strictEqual(await flags(), QUARTER);
  });

  it("walks up through the half and three quarters", async () => {
    const seen: number[] = [];
    // Five contributors at the 10% cap each takes the vault to 50%.
    for (let i = 0; i < 5; i++) {
      (await contributeFromSomeoneNew(CAP)).forEach((e) => seen.push(e.quarter));
    }
    assert.deepStrictEqual(seen, [1, 2], "the quarter, then the half");
    assert.strictEqual(await flags(), QUARTER | HALF);

    // Three more take it to 80%.
    for (let i = 0; i < 3; i++) {
      (await contributeFromSomeoneNew(CAP)).forEach((e) => seen.push(e.quarter));
    }
    assert.deepStrictEqual(seen, [1, 2, 3], "and then three quarters");
    assert.strictEqual(await flags(), QUARTER | HALF | THREE_QUARTERS);
  });
});
