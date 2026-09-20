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

function anchorCode(err: any): string | undefined {
  return (
    err?.error?.errorCode?.code ??
    err?.error?.code ??
    (typeof err?.message === "string"
      ? err.message.match(/Error Code: (\w+)/)?.[1]
      : undefined)
  );
}

function expectAnchorError(err: any, code: string) {
  if (String(err?.message ?? "").startsWith("expected ")) {
    throw err;
  }
  const got = anchorCode(err);
  assert.strictEqual(got, code, `expected ${code}, got ${got}\n${err}`);
}

describe("lottery", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const wallet = provider.wallet as NodeWallet;

  const maker = anchor.web3.Keypair.generate();
  const players = Array.from({ length: 10 }, () =>
    anchor.web3.Keypair.generate()
  );

  const TARGET = new anchor.BN(30_000_000);
  const MAX_ONE = new anchor.BN(3_000_000);

  let mint: anchor.web3.PublicKey;
  let fundraiser: anchor.web3.PublicKey;
  let vault: anchor.web3.PublicKey;

  const confirm = async (sig: string) => {
    const block = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...block });
    return sig;
  };

  const pdaContributor = (who: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), who.toBuffer()],
      program.programId
    )[0];

  before(async () => {
    await provider.connection
      .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then(confirm);
    for (const p of players) {
      await provider.connection
        .requestAirdrop(p.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
        .then(confirm);
    }

    mint = await createMint(
      provider.connection,
      wallet.payer,
      provider.publicKey,
      provider.publicKey,
      6
    );

    fundraiser = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
      program.programId
    )[0];
    vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

    for (const p of players) {
      const ata = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          wallet.payer,
          mint,
          p.publicKey
        )
      ).address;
      await mintTo(
        provider.connection,
        wallet.payer,
        mint,
        ata,
        provider.publicKey,
        10_000_000
      );
    }

    await program.methods
      .initialize(TARGET, 7)
      .accountsPartial({
        maker: maker.publicKey,
        fundraiser,
        mintToRaise: mint,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc()
      .then(confirm);
  });

  it("assigns contiguous ticket ranges as people contribute", async () => {
    for (let i = 0; i < 10; i++) {
      const p = players[i];
      const ata = (
        await getOrCreateAssociatedTokenAccount(
          provider.connection,
          wallet.payer,
          mint,
          p.publicKey
        )
      ).address;
      await program.methods
        .contribute(MAX_ONE)
        .accountsPartial({
          contributor: p.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount: pdaContributor(p.publicKey),
          contributorAta: ata,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([p])
        .rpc()
        .then(confirm);
    }

    const f = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(f.totalTickets.toNumber(), 30_000_000);
    assert.strictEqual(f.drawn, false);

    const first = await program.account.contributor.fetch(
      pdaContributor(players[0].publicKey)
    );
    const second = await program.account.contributor.fetch(
      pdaContributor(players[1].publicKey)
    );
    assert.strictEqual(first.ticketStart.toNumber(), 0);
    assert.strictEqual(first.ticketEnd.toNumber(), 3_000_000);
    assert.strictEqual(second.ticketStart.toNumber(), 3_000_000);
    assert.strictEqual(second.ticketEnd.toNumber(), 6_000_000);
  });

  it("refuses claim before draw", async () => {
    try {
      await program.methods
        .claimPrize()
        .accountsPartial({
          claimant: players[0].publicKey,
          fundraiser,
          contributorAccount: pdaContributor(players[0].publicKey),
        })
        .signers([players[0]])
        .rpc();
      assert.fail("expected NotDrawn");
    } catch (err: any) {
      expectAnchorError(err, "NotDrawn");
    }
  });

  it("draws once, only the holding range can claim", async () => {
    await program.methods
      .draw()
      .accountsPartial({
        fundraiser,
        mintToRaise: mint,
        vault,
        slotHashes: anchor.web3.SYSVAR_SLOT_HASHES_PUBKEY,
      })
      .rpc()
      .then(confirm);

    const f = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(f.drawn, true);
    const t = f.winningTicket.toNumber();
    assert.isAtLeast(t, 0);
    assert.isBelow(t, 30_000_000);

    try {
      await program.methods
        .draw()
        .accountsPartial({
          fundraiser,
          mintToRaise: mint,
          vault,
          slotHashes: anchor.web3.SYSVAR_SLOT_HASHES_PUBKEY,
        })
        .rpc();
      assert.fail("expected AlreadyDrawn");
    } catch (err: any) {
      expectAnchorError(err, "AlreadyDrawn");
    }

    const winnerIdx = Math.floor(t / 3_000_000);
    const winner = players[winnerIdx];
    const loser = players[winnerIdx === 0 ? 1 : 0];

    try {
      await program.methods
        .claimPrize()
        .accountsPartial({
          claimant: loser.publicKey,
          fundraiser,
          contributorAccount: pdaContributor(loser.publicKey),
        })
        .signers([loser])
        .rpc();
      assert.fail("expected NotAWinner");
    } catch (err: any) {
      expectAnchorError(err, "NotAWinner");
    }

    await program.methods
      .claimPrize()
      .accountsPartial({
        claimant: winner.publicKey,
        fundraiser,
        contributorAccount: pdaContributor(winner.publicKey),
      })
      .signers([winner])
      .rpc()
      .then(confirm);

    const after = await program.account.fundraiser.fetch(fundraiser);
    assert.strictEqual(after.prizeClaimed, true);

    try {
      await program.methods
        .claimPrize()
        .accountsPartial({
          claimant: winner.publicKey,
          fundraiser,
          contributorAccount: pdaContributor(winner.publicKey),
        })
        .signers([winner])
        .rpc();
      assert.fail("expected PrizeAlreadyClaimed");
    } catch (err: any) {
      expectAnchorError(err, "PrizeAlreadyClaimed");
    }
  });
});