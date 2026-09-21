import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as os from "os";
import * as path from "path";
import { Fundraiser } from "../target/types/fundraiser";

const TARGET = new anchor.BN(30_000_000);
const PER_WALLET = new anchor.BN(3_000_000);

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

async function main() {
  if (process.env.ANCHOR_WALLET) {
    process.env.ANCHOR_WALLET = expandHome(process.env.ANCHOR_WALLET);
  }
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Fundraiser as Program<Fundraiser>;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const maker = anchor.web3.Keypair.generate();
  await provider.connection
    .requestAirdrop(maker.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
    .then((s) => provider.connection.confirmTransaction(s));

  const mint = await createMint(
    provider.connection,
    payer,
    payer.publicKey,
    payer.publicKey,
    6,
  );
  const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
    program.programId,
  );
  const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);

  await program.methods
    .initialize(TARGET, 7)
    .accountsPartial({
      maker: maker.publicKey,
      minter: payer.publicKey,
      mintToRaise: mint,
      vault,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .signers([maker])
    .rpc();
  console.log("fundraiser", fundraiser.toBase58());

  for (let i = 0; i < 10; i++) {
    const wallet = anchor.web3.Keypair.generate();
    await provider.connection
      .requestAirdrop(wallet.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
      .then((s) => provider.connection.confirmTransaction(s));
    const ata = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        mint,
        wallet.publicKey,
      )
    ).address;
    await mintTo(provider.connection, payer, mint, ata, payer, 3_000_000);

    const [contributorAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        fundraiser.toBuffer(),
        wallet.publicKey.toBuffer(),
      ],
      program.programId,
    );
    await program.methods
      .contribute(PER_WALLET)
      .accountsPartial({
        contributor: wallet.publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount,
        contributorAta: ata,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();
    console.log("contributed", i + 1, wallet.publicKey.toBase58());
  }

  const makerAta = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      maker.publicKey,
    )
  ).address;
  await program.methods
    .checkContributions()
    .accountsPartial({
      maker: maker.publicKey,
      mintToRaise: mint,
      fundraiser,
      vault,
      makerAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .signers([maker])
    .rpc();
  console.log("claimed — observer should print airdropped × 10");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
