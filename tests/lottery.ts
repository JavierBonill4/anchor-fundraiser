import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Fundraiser } from "../target/types/fundraiser";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { Clock, ProgramTestContext } from "solana-bankrun";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { assert, AssertionError } from "chai";

/**
 * The lottery.
 *
 * Every contribution buys a contiguous range of ticket numbers. When the maker
 * settles a successful campaign the program reads the newest slot hash, reduces
 * it modulo the ticket count, and records the winning number. The program never
 * learns who won — a program cannot enumerate Contributor PDAs — so the holder
 * comes forward and proves the number falls inside their own range.
 *
 * Run on bankrun rather than a validator: the campaigns here need eleven funded
 * contributors each, and spinning that up against a real validator for every
 * case is slow.
 */
describe("fundraiser — lottery", () => {
  // 40 tokens at 6 decimals. Big enough that the 10% cap (4 tokens) leaves room
  // above the one-whole-token minimum, so a contributor can top up.
  const TARGET = 40_000_000;
  const PER_CONTRIBUTOR = TARGET / 10; // the program caps a contributor at 10%
  const CONTRIBUTORS = 11; // ten to reach the target, one more to create a prize
  const OVERSHOOT = CONTRIBUTORS * PER_CONTRIBUTOR - TARGET;
  const DURATION_DAYS = 7;

  let context: ProgramTestContext;
  let program: Program<Fundraiser>;
  let payer: anchor.web3.Keypair;

  before(async () => {
    context = await startAnchor("", [], []);
    const provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    program = new anchor.Program<Fundraiser>(
      require("../target/idl/fundraiser.json"),
      provider
    );
    payer = context.payer;
  });

  const send = async (
    ixs: anchor.web3.TransactionInstruction[],
    signers: anchor.web3.Keypair[] = []
  ) => {
    const tx = new anchor.web3.Transaction();
    const [blockhash] = await context.banksClient.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.add(...ixs);
    tx.sign(payer, ...signers);
    return context.banksClient.processTransaction(tx);
  };

  const tokenBalance = async (
    address: anchor.web3.PublicKey
  ): Promise<bigint> => {
    const account = await context.banksClient.getAccount(address);
    if (account === null) return 0n;
    return unpackAccount(address, {
      ...account,
      data: Buffer.from(account.data),
      owner: new anchor.web3.PublicKey(account.owner),
    } as any).amount;
  };

  /**
   * `banksClient.processTransaction` throws a plain string, so a raw
   * `custom program error: 0x1780` has to be looked back up in the IDL.
   */
  const errorCodeOf = (err: any): string => {
    if (err instanceof AssertionError) throw err;
    if (err?.error?.errorCode?.code) return err.error.errorCode.code;

    const text = `${err?.message ?? ""} ${JSON.stringify(err?.logs ?? [])}`;

    const byName = text.match(/Error Code: (\w+)/);
    if (byName) return byName[1];

    const byNumber = text.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (byNumber) {
      const code = parseInt(byNumber[1], 16);
      const known = (program.idl.errors ?? []).find((e: any) => e.code === code);
      if (known) return known.name;
      return `custom error ${code}`;
    }
    return text.slice(0, 300);
  };

  const assertErrorIs = (err: any, expected: string, why: string) => {
    const actual = errorCodeOf(err);
    assert.strictEqual(
      actual.toLowerCase(),
      expected.toLowerCase(),
      `${why} (expected ${expected}, got ${actual})`
    );
  };

  type Campaign = {
    maker: anchor.web3.Keypair;
    mint: anchor.web3.PublicKey;
    fundraiser: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
    makerAta: anchor.web3.PublicKey;
    backers: {
      keypair: anchor.web3.Keypair;
      ata: anchor.web3.PublicKey;
      account: anchor.web3.PublicKey;
    }[];
  };

  /**
   * Opens a campaign and runs `contributors` contributions of PER_CONTRIBUTOR
   * each, in order, so ticket ranges come out as [0,1M), [1M,2M), ...
   */
  const openCampaign = async (
    contributors = CONTRIBUTORS,
    perContributor = PER_CONTRIBUTOR
  ): Promise<Campaign> => {
    const maker = anchor.web3.Keypair.generate();
    const mintKeypair = anchor.web3.Keypair.generate();
    const mint = mintKeypair.publicKey;

    const rent = await context.banksClient.getRent();
    const mintRent = Number(rent.minimumBalance(BigInt(MINT_SIZE)));

    await send(
      [
        anchor.web3.SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: maker.publicKey,
          lamports: anchor.web3.LAMPORTS_PER_SOL,
        }),
        anchor.web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint,
          space: MINT_SIZE,
          lamports: mintRent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mint, 6, payer.publicKey, null),
      ],
      [mintKeypair]
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );
    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
    const makerAta = getAssociatedTokenAddressSync(mint, maker.publicKey);

    await send(
      [
        await program.methods
          .initialize(new anchor.BN(TARGET), DURATION_DAYS)
          .accountsPartial({
            maker: maker.publicKey,
            mintToRaise: mint,
            fundraiser,
            vault,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .instruction(),
      ],
      [maker]
    );

    const backers: Campaign["backers"] = [];

    for (let i = 0; i < contributors; i++) {
      const keypair = anchor.web3.Keypair.generate();
      const ata = getAssociatedTokenAddressSync(mint, keypair.publicKey);
      const [account] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from("contributor"),
          fundraiser.toBuffer(),
          keypair.publicKey.toBuffer(),
        ],
        program.programId
      );

      await send(
        [
          anchor.web3.SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: keypair.publicKey,
            lamports: anchor.web3.LAMPORTS_PER_SOL,
          }),
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            ata,
            keypair.publicKey,
            mint
          ),
          createMintToInstruction(mint, ata, payer.publicKey, perContributor),
          await program.methods
            .contribute(new anchor.BN(perContributor))
            .accountsPartial({
              contributor: keypair.publicKey,
              mintToRaise: mint,
              fundraiser,
              contributorAccount: account,
              contributorAta: ata,
              vault,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .instruction(),
        ],
        [keypair]
      );

      backers.push({ keypair, ata, account });
    }

    return { maker, mint, fundraiser, vault, makerAta, backers };
  };

  const drawIx = (c: Campaign) =>
    program.methods
      .checkContributions()
      .accountsPartial({
        maker: c.maker.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        vault: c.vault,
        makerAta: c.makerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .instruction();

  const claimIx = (c: Campaign, backer: Campaign["backers"][number]) =>
    program.methods
      .claimPrize()
      .accountsPartial({
        winner: backer.keypair.publicKey,
        maker: c.maker.publicKey,
        mintToRaise: c.mint,
        fundraiser: c.fundraiser,
        contributorAccount: backer.account,
        vault: c.vault,
        winnerAta: backer.ata,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .instruction();

  /** The backer whose half-open range contains `ticket`. */
  const holderOf = (c: Campaign, ticket: number) =>
    c.backers[Math.floor(ticket / PER_CONTRIBUTOR)];

  // ---------------------------------------------------------------- happy path

  it("issues contiguous ticket ranges as contributions arrive", async () => {
    const c = await openCampaign(3);

    const fundraiser = await program.account.fundraiser.fetch(c.fundraiser);
    assert.strictEqual(
      fundraiser.totalTickets.toNumber(),
      3 * PER_CONTRIBUTOR,
      "one ticket per raw token, for every contribution"
    );

    let expectedStart = 0;
    for (const backer of c.backers) {
      const account = await program.account.contributor.fetch(backer.account);
      assert.strictEqual(
        account.ticketStart.toNumber(),
        expectedStart,
        "each range must begin where the previous one ended"
      );
      assert.strictEqual(
        account.ticketEnd.toNumber(),
        expectedStart + PER_CONTRIBUTOR,
        "the range width is the contribution"
      );
      expectedStart += PER_CONTRIBUTOR;
    }
  });

  it("draws a winner on settlement and pays the overshoot to the ticket holder", async () => {
    const c = await openCampaign();

    const makerBefore = await tokenBalance(c.makerAta);
    await send([await drawIx(c)], [c.maker]);

    const fundraiser = await program.account.fundraiser.fetch(c.fundraiser);
    assert.isTrue(fundraiser.drawn, "the draw should have fired");

    const winning = fundraiser.winningTicket.toNumber();
    assert.isAtLeast(winning, 0);
    assert.isBelow(
      winning,
      fundraiser.totalTickets.toNumber(),
      "the winning ticket must be one that was actually issued"
    );

    // The maker is paid the target, never more. The rest is the prize.
    assert.strictEqual(
      (await tokenBalance(c.makerAta)) - makerBefore,
      BigInt(TARGET),
      "the maker receives exactly what they asked to raise"
    );
    assert.strictEqual(
      await tokenBalance(c.vault),
      BigInt(OVERSHOOT),
      "the overshoot stays in the vault as the prize"
    );

    // Nobody told the program who won — the holder comes forward and proves it.
    const winner = holderOf(c, winning);
    const winnerAccount = await program.account.contributor.fetch(
      winner.account
    );
    assert.isTrue(
      winnerAccount.ticketStart.toNumber() <= winning &&
        winning < winnerAccount.ticketEnd.toNumber(),
      "the drawn number must fall inside exactly one live range"
    );

    const winnerBefore = await tokenBalance(winner.ata);
    await send([await claimIx(c, winner)], [winner.keypair]);

    assert.strictEqual(
      (await tokenBalance(winner.ata)) - winnerBefore,
      BigInt(OVERSHOOT),
      "the winner receives the whole prize"
    );
    assert.strictEqual(
      await tokenBalance(c.vault),
      0n,
      "the vault is drained by the claim"
    );
    assert.isNull(
      await context.banksClient.getAccount(c.fundraiser),
      "claiming closes the campaign and returns its rent to the maker"
    );
  });

  // ------------------------------------------------------------------ boundary

  it("treats the ticket range as half open, so neither neighbour can claim", async () => {
    const c = await openCampaign();
    await send([await drawIx(c)], [c.maker]);

    const fundraiser = await program.account.fundraiser.fetch(c.fundraiser);
    const winning = fundraiser.winningTicket.toNumber();
    const winnerIndex = Math.floor(winning / PER_CONTRIBUTOR);

    const winnerAccount = await program.account.contributor.fetch(
      c.backers[winnerIndex].account
    );

    // Both sides, so the `<=` and the `<` in the range check are each covered. The
    // ranges are contiguous, so the backer below shares an edge with the winner's
    // ticket_start and the one above shares an edge with their ticket_end. Getting
    // either comparison wrong hands one of them someone else's prize.
    for (const index of [winnerIndex - 1, winnerIndex + 1]) {
      if (index < 0 || index >= c.backers.length) continue;

      const neighbour = c.backers[index];
      const account = await program.account.contributor.fetch(neighbour.account);

      if (index < winnerIndex) {
        assert.strictEqual(
          account.ticketEnd.toNumber(),
          winnerAccount.ticketStart.toNumber(),
          "the range below must end exactly where the winner's begins"
        );
      } else {
        assert.strictEqual(
          account.ticketStart.toNumber(),
          winnerAccount.ticketEnd.toNumber(),
          "the range above must begin exactly where the winner's ends"
        );
      }

      assert.isFalse(
        account.ticketStart.toNumber() <= winning &&
          winning < account.ticketEnd.toNumber(),
        "the neighbour must not hold the winning number"
      );

      try {
        await send([await claimIx(c, neighbour)], [neighbour.keypair]);
        assert.fail("a contributor outside the winning range must not be paid");
      } catch (err) {
        assertErrorIs(
          err,
          "NotWinningTicket",
          "the claim should be refused on the range check"
        );
      }
    }
  });

  // --------------------------------------------------------------- abuse cases

  it("refuses a refund once the campaign has been settled", async () => {
    const c = await openCampaign();
    await send([await drawIx(c)], [c.maker]);

    const prizeBefore = await tokenBalance(c.vault);
    assert.strictEqual(prizeBefore, BigInt(OVERSHOOT));

    // Past the deadline. A settled campaign has already paid the maker, so the
    // vault now holds only the prize — which is below the target, and that is
    // exactly the condition `refund` checks.
    const before = await context.banksClient.getClock();
    context.warpToSlot(before.slot + 8n * 216_000n);
    const clock = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        before.unixTimestamp + 8n * 86_400n
      )
    );

    const backer = c.backers[0];
    try {
      await send(
        [
          await program.methods
            .refund()
            .accountsPartial({
              contributor: backer.keypair.publicKey,
              maker: c.maker.publicKey,
              mintToRaise: c.mint,
              fundraiser: c.fundraiser,
              contributorAccount: backer.account,
              contributorAta: backer.ata,
              vault: c.vault,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .instruction(),
        ],
        [backer.keypair]
      );
      assert.fail("a settled campaign must not pay refunds out of the prize");
    } catch (err) {
      assertErrorIs(
        err,
        "AlreadyDrawn",
        "the refund should be refused because the campaign already settled"
      );
    }

    assert.strictEqual(
      await tokenBalance(c.vault),
      prizeBefore,
      "the prize must be untouched"
    );
  });

  it("refuses a contribution once the winner has been drawn", async () => {
    const c = await openCampaign();
    await send([await drawIx(c)], [c.maker]);

    // The window is still open — the draw fired as soon as the target was met.
    // Tickets sold now could never win, and the money would silently inflate the
    // prize the already-decided winner is about to collect.
    const latecomer = anchor.web3.Keypair.generate();
    const ata = getAssociatedTokenAddressSync(c.mint, latecomer.publicKey);
    const [account] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        c.fundraiser.toBuffer(),
        latecomer.publicKey.toBuffer(),
      ],
      program.programId
    );

    try {
      await send(
        [
          anchor.web3.SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: latecomer.publicKey,
            lamports: anchor.web3.LAMPORTS_PER_SOL,
          }),
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            ata,
            latecomer.publicKey,
            c.mint
          ),
          createMintToInstruction(
            c.mint,
            ata,
            payer.publicKey,
            PER_CONTRIBUTOR
          ),
          await program.methods
            .contribute(new anchor.BN(PER_CONTRIBUTOR))
            .accountsPartial({
              contributor: latecomer.publicKey,
              mintToRaise: c.mint,
              fundraiser: c.fundraiser,
              contributorAccount: account,
              contributorAta: ata,
              vault: c.vault,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .instruction(),
        ],
        [latecomer]
      );
      assert.fail("a contribution after the draw must be refused");
    } catch (err) {
      assertErrorIs(
        err,
        "AlreadyDrawn",
        "tickets sold after the draw could never win"
      );
    }
  });

  it("refuses a second draw, so the maker cannot re-roll on a later slot hash", async () => {
    const c = await openCampaign();
    await send([await drawIx(c)], [c.maker]);

    try {
      // A lamport transfer alongside it, purely so the second transaction is not
      // byte-identical to the first — the bank rejects an exact replay before the
      // program ever runs.
      await send(
        [
          anchor.web3.SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: c.maker.publicKey,
            lamports: 1,
          }),
          await drawIx(c),
        ],
        [c.maker]
      );
      assert.fail("the draw must fire exactly once");
    } catch (err) {
      assertErrorIs(err, "AlreadyDrawn", "the second draw should be refused");
    }
  });

  it("refuses a claim before the draw has happened", async () => {
    const c = await openCampaign();

    try {
      await send([await claimIx(c, c.backers[0])], [c.backers[0].keypair]);
      assert.fail("there is no winner to claim as yet");
    } catch (err) {
      assertErrorIs(err, "NotDrawn", "the claim should be refused");
    }
  });

  it("lets a contributor extend their range while it is still the last one", async () => {
    // Half the cap each, so there is headroom to top up.
    const c = await openCampaign(1, PER_CONTRIBUTOR / 2);
    const backer = c.backers[0];

    await send(
      [
        createMintToInstruction(
          c.mint,
          backer.ata,
          payer.publicKey,
          PER_CONTRIBUTOR / 2
        ),
        await program.methods
          .contribute(new anchor.BN(PER_CONTRIBUTOR / 2))
          .accountsPartial({
            contributor: backer.keypair.publicKey,
            mintToRaise: c.mint,
            fundraiser: c.fundraiser,
            contributorAccount: backer.account,
            contributorAta: backer.ata,
            vault: c.vault,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
      ],
      [backer.keypair]
    );

    const account = await program.account.contributor.fetch(backer.account);
    assert.strictEqual(account.ticketStart.toNumber(), 0);
    assert.strictEqual(
      account.ticketEnd.toNumber(),
      PER_CONTRIBUTOR,
      "a contiguous top-up widens the existing range rather than replacing it"
    );
  });

  it("refuses a repeat contribution that would orphan the earlier tickets", async () => {
    // Two backers at half the cap: [0, 500k) and [500k, 1M).
    const c = await openCampaign(2, PER_CONTRIBUTOR / 2);
    const backer = c.backers[0];

    // The first backer now tops up, but someone else has taken the next range.
    // Overwriting would leave tickets [0, 500k) belonging to nobody, and the draw
    // could land on a number no live account could prove.
    try {
      await send(
        [
          createMintToInstruction(
            c.mint,
            backer.ata,
            payer.publicKey,
            PER_CONTRIBUTOR / 2
          ),
          await program.methods
            .contribute(new anchor.BN(PER_CONTRIBUTOR / 2))
            .accountsPartial({
              contributor: backer.keypair.publicKey,
              mintToRaise: c.mint,
              fundraiser: c.fundraiser,
              contributorAccount: backer.account,
              contributorAta: backer.ata,
              vault: c.vault,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .instruction(),
        ],
        [backer.keypair]
      );
      assert.fail("a non-contiguous top-up must be refused");
    } catch (err) {
      assertErrorIs(
        err,
        "NonContiguousTickets",
        "the contiguity check should reject it"
      );
    }

    // The tickets they already paid for are untouched.
    const account = await program.account.contributor.fetch(backer.account);
    assert.strictEqual(account.ticketStart.toNumber(), 0);
    assert.strictEqual(account.ticketEnd.toNumber(), PER_CONTRIBUTOR / 2);
  });
});
