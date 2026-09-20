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

describe("fundraiser — ticket raffle & lottery feature", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  // 1 token = 1_000_000 raw units (6 decimals).
  // Target = 10 tokens. 10% cap per contributor = 1 token.
  // Exactly 10 contributors of 1 token each reaches the 10 token target.
  const ONE_TOKEN = 1_000_000;
  const TARGET = 10 * ONE_TOKEN;
  const CONTRIBUTION = 1 * ONE_TOKEN;

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

  it("Checkpoint 6: Happy path — target reached, winner drawn via SlotHashes, prize claimed", async () => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );

    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    // Initialize campaign
    await program.methods
      .initialize(new anchor.BN(TARGET), 7)
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

    // Create 10 contributors and fund them
    const contributors: {
      keypair: anchor.web3.Keypair;
      ata: anchor.web3.PublicKey;
      pda: anchor.web3.PublicKey;
    }[] = [];

    for (let i = 0; i < 10; i++) {
      const kp = anchor.web3.Keypair.generate();
      await provider.connection
        .requestAirdrop(kp.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL)
        .then(confirm);

      const ata = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          wallet.payer,
          mint,
          kp.publicKey
        )
      ).address;

      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        ata,
        provider.publicKey,
        CONTRIBUTION
      ).then(confirm);

      const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("contributor"), fundraiser.toBuffer(), kp.publicKey.toBuffer()],
        program.programId
      );

      contributors.push({ keypair: kp, ata, pda });
    }

    // Each contributor contributes 1 whole token
    for (let i = 0; i < contributors.length; i++) {
      const c = contributors[i];
      await program.methods
        .contribute(new anchor.BN(CONTRIBUTION))
        .accountsPartial({
          contributor: c.keypair.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount: c.pda,
          contributorAta: c.ata,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([c.keypair])
        .rpc()
        .then(confirm);

      const cAccount = await program.account.contributor.fetch(c.pda);
      assert.strictEqual(
        cAccount.ticketStart.toNumber(),
        i * CONTRIBUTION,
        `Contributor ${i} ticketStart should match previous total`
      );
      assert.strictEqual(
        cAccount.ticketEnd.toNumber(),
        (i + 1) * CONTRIBUTION,
        `Contributor ${i} ticketEnd should be exclusive upper bound`
      );
    }

    const fundraiserAfterContributions = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(
      fundraiserAfterContributions.totalTickets.toNumber(),
      TARGET,
      "Total tickets should equal target amount"
    );
    assert.isFalse(fundraiserAfterContributions.winnerDrawn, "Winner not drawn yet");

    // Draw winner using SlotHashes sysvar
    await program.methods
      .drawWinner()
      .accountsPartial({
        caller: provider.publicKey,
        fundraiser,
        slotHashes: anchor.web3.SYSVAR_SLOT_HASHES_PUBKEY,
      })
      .rpc()
      .then(confirm);

    const fundraiserAfterDraw = await program.account.fundraiser.fetch(fundraiser);
    assert.isTrue(fundraiserAfterDraw.winnerDrawn, "Winner must be drawn");
    const winningTicket = fundraiserAfterDraw.winningTicket.toNumber();
    assert.isAtLeast(winningTicket, 0);
    assert.isBelow(winningTicket, TARGET);

    // Identify which contributor holds the winning ticket range
    const winnerIndex = Math.floor(winningTicket / CONTRIBUTION);
    const winner = contributors[winnerIndex];

    const winnerAtaBalanceBefore = Number(
      (await provider.connection.getTokenAccountBalance(winner.ata)).value.amount
    );
    assert.strictEqual(winnerAtaBalanceBefore, 0, "Winner spent all tokens contributing");

    // Winner claims 10% prize
    await program.methods
      .claimPrize()
      .accountsPartial({
        winner: winner.keypair.publicKey,
        fundraiser,
        contributorAccount: winner.pda,
        vault,
        winnerAta: winner.ata,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([winner.keypair])
      .rpc()
      .then(confirm);

    const fundraiserAfterClaim = await program.account.fundraiser.fetch(fundraiser);
    assert.isTrue(fundraiserAfterClaim.prizeClaimed, "Prize must be marked as claimed");

    const winnerAtaBalanceAfter = Number(
      (await provider.connection.getTokenAccountBalance(winner.ata)).value.amount
    );
    const expectedPrize = TARGET / 10; // 10% slice of 10 tokens = 1 token
    assert.strictEqual(
      winnerAtaBalanceAfter,
      expectedPrize,
      "Winner should receive exactly 10% slice of the vault"
    );

    // Abuse check in-place: Repeated claim must fail with PrizeAlreadyClaimed
    try {
      await program.methods
        .claimPrize()
        .accountsPartial({
          winner: winner.keypair.publicKey,
          fundraiser,
          contributorAccount: winner.pda,
          vault,
          winnerAta: winner.ata,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([winner.keypair])
        .rpc();
      assert.fail("Repeated claim should fail");
    } catch (err) {
      assertErrorIs(err, "PrizeAlreadyClaimed", "Repeated claim rejected");
    }

    // Abuse check in-place: Repeated draw must fail with WinnerAlreadyDrawn
    try {
      await program.methods
        .drawWinner()
        .accountsPartial({
          caller: provider.publicKey,
          fundraiser,
          slotHashes: anchor.web3.SYSVAR_SLOT_HASHES_PUBKEY,
        })
        .rpc();
      assert.fail("Repeated draw should fail");
    } catch (err) {
      assertErrorIs(err, "WinnerAlreadyDrawn", "Repeated draw rejected");
    }
  });

  it("Checkpoint 6: Boundary case — draw rejected before target met, claim rejected for adjacent ticket holder", async () => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
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

    // Contributor 1 contributes 1 token (target 10 tokens not met)
    const contributor1 = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(contributor1.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const c1Ata = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        wallet.payer,
        mint,
        contributor1.publicKey
      )
    ).address;

    await mintTo(
      provider.connection,
      wallet.payer,
      mint,
      c1Ata,
      provider.publicKey,
      CONTRIBUTION
    ).then(confirm);

    const [c1Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), contributor1.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .contribute(new anchor.BN(CONTRIBUTION))
      .accountsPartial({
        contributor: contributor1.publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount: c1Pda,
        contributorAta: c1Ata,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor1])
      .rpc()
      .then(confirm);

    // Boundary check 1: draw_winner before target met must be rejected with TargetNotMet
    try {
      await program.methods
        .drawWinner()
        .accountsPartial({
          caller: provider.publicKey,
          fundraiser,
          slotHashes: anchor.web3.SYSVAR_SLOT_HASHES_PUBKEY,
        })
        .rpc();
      assert.fail("draw_winner should fail when target is not met");
    } catch (err) {
      assertErrorIs(err, "TargetNotMet", "draw_winner before target met");
    }

    // Now fill the campaign to target
    const extraContributors: {
      keypair: anchor.web3.Keypair;
      ata: anchor.web3.PublicKey;
      pda: anchor.web3.PublicKey;
    }[] = [];

    for (let i = 1; i < 10; i++) {
      const kp = anchor.web3.Keypair.generate();
      await provider.connection
        .requestAirdrop(kp.publicKey, anchor.web3.LAMPORTS_PER_SOL)
        .then(confirm);

      const ata = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          wallet.payer,
          mint,
          kp.publicKey
        )
      ).address;

      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        ata,
        provider.publicKey,
        CONTRIBUTION
      ).then(confirm);

      const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("contributor"), fundraiser.toBuffer(), kp.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .contribute(new anchor.BN(CONTRIBUTION))
        .accountsPartial({
          contributor: kp.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount: pda,
          contributorAta: ata,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([kp])
        .rpc()
        .then(confirm);

      extraContributors.push({ keypair: kp, ata, pda });
    }

    // Draw winner
    await program.methods
      .drawWinner()
      .accountsPartial({
        caller: provider.publicKey,
        fundraiser,
        slotHashes: anchor.web3.SYSVAR_SLOT_HASHES_PUBKEY,
      })
      .rpc()
      .then(confirm);

    const fState = await program.account.fundraiser.fetch(fundraiser);
    const winningTicket = fState.winningTicket.toNumber();
    const allContributors = [{ keypair: contributor1, ata: c1Ata, pda: c1Pda }, ...extraContributors];
    const winnerIdx = Math.floor(winningTicket / CONTRIBUTION);

    // Pick a non-winning adjacent contributor
    const nonWinnerIdx = winnerIdx === 0 ? 1 : winnerIdx - 1;
    const nonWinner = allContributors[nonWinnerIdx];

    // Boundary check 2: Adjacent ticket holder claims -> must be rejected with NotWinningTicket
    try {
      await program.methods
        .claimPrize()
        .accountsPartial({
          winner: nonWinner.keypair.publicKey,
          fundraiser,
          contributorAccount: nonWinner.pda,
          vault,
          winnerAta: nonWinner.ata,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([nonWinner.keypair])
        .rpc();
      assert.fail("Non-winning contributor should fail claiming prize");
    } catch (err) {
      assertErrorIs(err, "NotWinningTicket", "Non-winning ticket claim rejected");
    }
  });

  it("Checkpoint 6: Abuse case — non-contiguous repeat contribution rejected", async () => {
    const maker = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    );

    const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    // Set target to 20 tokens so 10% max contribution per contributor is 2 tokens
    const TARGET_20 = 20 * ONE_TOKEN;

    await program.methods
      .initialize(new anchor.BN(TARGET_20), 7)
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

    const c1 = anchor.web3.Keypair.generate();
    const c2 = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(c1.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);
    await provider.connection
      .requestAirdrop(c2.publicKey, anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);

    const c1Ata = (
      await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, mint, c1.publicKey)
    ).address;
    const c2Ata = (
      await getOrCreateAssociatedTokenAccount(provider.connection, wallet.payer, mint, c2.publicKey)
    ).address;

    await mintTo(provider.connection, wallet.payer, mint, c1Ata, provider.publicKey, 2 * CONTRIBUTION).then(confirm);
    await mintTo(provider.connection, wallet.payer, mint, c2Ata, provider.publicKey, CONTRIBUTION).then(confirm);

    const [c1Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), c1.publicKey.toBuffer()],
      program.programId
    );
    const [c2Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), c2.publicKey.toBuffer()],
      program.programId
    );

    // C1 contributes 1 token (C1 total = 1 token, max allowed is 2 tokens)
    await program.methods
      .contribute(new anchor.BN(CONTRIBUTION))
      .accountsPartial({
        contributor: c1.publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount: c1Pda,
        contributorAta: c1Ata,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([c1])
      .rpc()
      .then(confirm);

    // C2 contributes 1 token next (takes ticket range [1 token, 2 tokens))
    await program.methods
      .contribute(new anchor.BN(CONTRIBUTION))
      .accountsPartial({
        contributor: c2.publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount: c2Pda,
        contributorAta: c2Ata,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([c2])
      .rpc()
      .then(confirm);

    // C1 tries to contribute another 1 token (total 2 tokens <= 2 token cap, but non-contiguous with previous tickets)
    try {
      await program.methods
        .contribute(new anchor.BN(CONTRIBUTION))
        .accountsPartial({
          contributor: c1.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount: c1Pda,
          contributorAta: c1Ata,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([c1])
        .rpc();
      assert.fail("Non-contiguous repeat contribution should fail");
    } catch (err) {
      assertErrorIs(err, "NonContiguousContribution", "Non-contiguous repeat contribution rejected");
    }
  });
});
