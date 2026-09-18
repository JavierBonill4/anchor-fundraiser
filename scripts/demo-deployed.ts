import fs from "fs";
import os from "os";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { sendAndConfirmTransaction } from "@solana/web3.js";
import { Fundraiser } from "../target/types/fundraiser";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

/**
 * Live demo against the deployed devnet fundraiser.
 *
 *   Program : 8tNkFQaUao8jz9Px2XSCe6aUrcU5uo29b54tAJSTL64S
 *   Authority: ~/.config/solana/id.json (pays fees, is the upgrade authority)
 *
 * Run (from the repo root, after `anchor build` so the local IDL is current):
 *
 *   yarn ts-node scripts/demo-deployed.ts
 *
 * The funded demo wallets are persisted to scripts/.demo-wallets.json
 * (gitignored) so leftover SOL can be recovered:
 *
 *   RECOVER=1 yarn ts-node scripts/demo-deployed.ts
 *
 * It creates a fresh mint and fundraiser, then walks through the tiered
 * contribution cap: the flat 10% cap below half, the unlock to 20% at 50%,
 * the per-contributor ceilings at 20% and 30%, the refund guard while the
 * window is open, and finally the maker sweeping the pot.
 */
const PROGRAM_ID = "8tNkFQaUao8jz9Px2XSCe6aUrcU5uo29b54tAJSTL64S";
const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const WALLET_PATH =
  process.env.KEYPAIR_PATH || path.join(os.homedir(), ".config/solana/id.json");

const ONE_TOKEN = 1_000_000; // 6 decimals
const DECIMALS = 6;
const TARGET = 30_000_000; // 30 tokens
const durationDays = 7;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The demo funds throwaway maker/contributor wallets. Those keypairs are
// persisted here (and gitignored) so leftover SOL can always be recovered.
const WALLETS_FILE = path.join(__dirname, ".demo-wallets.json");

const persistKeys = (keys: anchor.web3.Keypair[]) => {
  const dump: Record<string, string> = {};
  keys.forEach((k, i) => {
    const name = i === 0 ? "maker" : `contributor-${i}`;
    dump[name] = Buffer.from(k.secretKey).toString("hex");
  });
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(dump, null, 2));
};

const sweepLeftoverSols = async () => {
  let dump: Record<string, string>;
  try {
    dump = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
  } catch {
    return; // no wallet file -> nothing to recover
  }
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf-8")));
  const authorityPair = anchor.web3.Keypair.fromSecretKey(secret);
  const connection = new anchor.web3.Connection(RPC, "confirmed");
  const MIN_SWEEP = 100_000; // lamports; skip wallets with nothing meaningful
  for (const [name, hex] of Object.entries(dump)) {
    if (name === "provider") continue;
    const k = anchor.web3.Keypair.fromSecretKey(Buffer.from(hex, "hex"));
    const bal = await retried(() => connection.getBalance(k.publicKey, "confirmed"));
    if (bal < MIN_SWEEP) continue; // nothing meaningful to recover
    const tx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: k.publicKey,
        toPubkey: authorityPair.publicKey,
        lamports: bal,
      })
    );
    tx.feePayer = authorityPair.publicKey;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sendAndConfirmTransaction(connection, tx, [k, authorityPair], {
          commitment: "confirmed",
          skipPreflight: true,
        });
        console.log(
          `  [recover] ${name}: returned ${(bal / 1e9).toFixed(4)} SOL`
        );
        break;
      } catch {
        if (attempt === 2) {
          console.error(`  [recover] ${name}: failed to sweep (${(bal / 1e9).toFixed(4)} SOL)`);
        }
        await sleep(1500);
      }
    }
  }
};

// retry read-only RPC calls on transient transport failures (devnet RPCs drop
// connections / rate-limit; permanent errors like TokenAccountNotFound pass through).
const retried = async <T>(
  fn: () => Promise<T>,
  tries = 5
): Promise<T> => {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = `${(e as any)?.message ?? e}`;
      const retryable =
        msg.includes("fetch failed") ||
        msg.includes("Failed to fetch") ||
        msg.includes("429") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNRESET") ||
        msg.includes("socket");
      if (!retryable) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
};

async function main() {
  console.log("== fundraiser on devnet - tiered contribution cap demo ==\n");

  if (process.env.RECOVER === "1") {
    console.log("== recovery mode: sweeping leftover SOL back to the authority ==\n");
    await sweepLeftoverSols();
    console.log("\n== recovery complete ==");
    return;
  }

  const secret = Uint8Array.from(
    JSON.parse(fs.readFileSync(WALLET_PATH, "utf-8"))
  );
  const authorityPair = anchor.web3.Keypair.fromSecretKey(secret);
  const connection = new anchor.web3.Connection(RPC, "confirmed");
  const wallet = new NodeWallet(authorityPair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);

  console.log("authority (payer) :", authorityPair.publicKey.toBase58());
  console.log("program id        :", PROGRAM_ID);
  console.log("cluster           :", RPC, "\n");

  const idl = require("../target/idl/fundraiser.json");
  console.log("IDL: loaded from local target/idl/fundraiser.json");
  const program = new anchor.Program<Fundraiser>(idl, provider);

  const sendConfirm = async (ix: anchor.web3.TransactionInstruction) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sendAndConfirmTransaction(
          connection,
          new anchor.web3.Transaction().add(ix),
          [authorityPair],
          { commitment: "confirmed", skipPreflight: true }
        );
        return;
      } catch (err) {
        if (attempt === 2) throw err;
        await sleep(1500);
      }
    }
  };

  const confirm = async (sig: string) => {
    const block = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature: sig, ...block });
  };

  const report = (name: string, ok: boolean, note = "") =>
    console.log(
      `${ok ? "  [OK] " : "  [!!] "}${name}${note ? " - " + note : ""}`
    );

  const errorCode = (err: any): string =>
    err?.error?.errorCode?.code ??
    (err?.message ?? "").match(/Error Code: (\w+)/)?.[1] ??
    "UNKNOWN";

  const expectedError = async (name: string, code: string, fn: () => Promise<any>) => {
    try {
      await fn();
      report(name, false, `expected ${code}, but it succeeded`);
    } catch (err) {
      const got = errorCode(err);
      report(name, got === code, `expected ${code}, got ${got}`);
    }
  };

  const tokens = (raw: number | string) =>
    `${(Number(raw) / ONE_TOKEN).toFixed(1)} t (${raw})`;

  const vaultBalance = async (v: anchor.web3.PublicKey) =>
    Number((await retried(() => connection.getTokenAccountBalance(v))).value.amount);

  // ---------------------------------------------------------------- setup
  console.log("--- setup ---");
  const maker = anchor.web3.Keypair.generate();
  const mint = await retried(() =>
    createMint(
      connection,
      authorityPair,
      authorityPair.publicKey,
      authorityPair.publicKey,
      DECIMALS
    )
  );
  report("mint created", true, mint.toBase58());

  // devnet RPCs drop sends: poll the balance and only consider it done once
  // the SOL is actually there; re-send if a signature never made it on-chain.
  const fund = async (k: anchor.web3.Keypair, lamports: number) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      if ((await retried(() => connection.getBalance(k.publicKey, "confirmed"))) >= lamports)
        return;
      try {
        await sendConfirm(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: authorityPair.publicKey,
            toPubkey: k.publicKey,
            lamports,
          })
        );
      } catch (e) {
        console.error(`  [warn] fund attempt ${attempt} failed:`, e?.message ?? e);
      }
      await sleep(1200);
    }
    const bal = await retried(() => connection.getBalance(k.publicKey, "confirmed"));
    if (bal < lamports)
      throw new Error(
        `could not fund ${k.publicKey.toBase58()} (${bal}/${lamports})`
      );
  };

  // maker pays the rent for the new fundraiser + vault accounts
  await fund(maker, 0.05 * anchor.web3.LAMPORTS_PER_SOL);

  // public devnet RPCs lag: create the ATA, then confirm its existence by
// polling instead of trusting a single fetch.
  const ensureAta = async (owner: anchor.web3.PublicKey) => {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await retried(() => connection.getAccountInfo(ata, "confirmed"))) return ata;
      if (attempt === 0) {
        try {
          await sendConfirm(
            createAssociatedTokenAccountInstruction(
              authorityPair.publicKey,
              ata,
              owner,
              mint
            )
          );
        } catch (e) {
          console.error("  [warn] ata-create failed:", e?.message ?? e);
        }
      }
      await sleep(1500);
    }
    throw new Error(`could not confirm ata ${ata.toBase58()}`);
  };

  const balanceOf = async (ata: anchor.web3.PublicKey) =>
    BigInt((await retried(() => connection.getTokenAccountBalance(ata, "confirmed"))).value.amount);

  // exactly-once: poll the balance, only re-send if the tokens never landed
  const mintTokensTo = async (ata: anchor.web3.PublicKey, amount: bigint) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      if ((await balanceOf(ata)) >= amount) return;
      try {
        await sendConfirm(
          createMintToInstruction(mint, ata, authorityPair.publicKey, amount)
        );
      } catch (e) {
        console.error(`  [warn] mintTo attempt ${attempt} failed:`, e?.message ?? e);
      }
      await sleep(1500);
    }
    if ((await balanceOf(ata)) < amount)
      throw new Error(`could not mint ${amount} tokens to ${ata.toBase58()}`);
  };

  const [fundraiser] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
    program.programId
  );
  const vault = getAssociatedTokenAddressSync(mint, fundraiser, true);
  const demoKeys: anchor.web3.Keypair[] = [maker];
  persistKeys(demoKeys);
  console.log("fundraiser PDA    :", fundraiser.toBase58());
  console.log("maker             :", maker.publicKey.toBase58());

  const mkContributor = async (tag: string) => {
    const c = anchor.web3.Keypair.generate();
    demoKeys.push(c);
    persistKeys(demoKeys);
    await fund(c, 0.02 * anchor.web3.LAMPORTS_PER_SOL);
    const ata = await ensureAta(c.publicKey);
    await mintTokensTo(ata, BigInt(9 * ONE_TOKEN));
    const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("contributor"), fundraiser.toBuffer(), c.publicKey.toBuffer()],
      program.programId
    );
    return { tag, keypair: c, ata, pda };
  };
  const A = await mkContributor("A");
  const B = await mkContributor("B");
  const C = await mkContributor("C");
  const D = await mkContributor("D");
  const E = await mkContributor("E");
  const F = await mkContributor("F");
  const G = await mkContributor("G");

  const contribute = (contributor, amount: number, preflight = false) =>
    program.methods
      .contribute(new anchor.BN(amount))
      .accountsPartial({
        contributor: contributor.keypair.publicKey,
        mintToRaise: mint,
        fundraiser,
        contributorAccount: contributor.pda,
        contributorAta: contributor.ata,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contributor.keypair])
      // rejection checks use preflight so anchor surfaces a decodable error
      .rpc(preflight ? undefined : { skipPreflight: true })
      .then(confirm);

  // ------------------------------------------------------------ campaign
  console.log("\n--- initialize: raise 30 tokens in 7 days ---");
  await program.methods
    .initialize(new anchor.BN(TARGET), durationDays)
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
  report("campaign open", true, `target ${tokens(TARGET)}, ${durationDays} days`);

  // ------------------------------------------------- tier 1 (< 50%)
  console.log("\n--- tier 1: vault below 50% caps everyone at 10% ---");
  await contribute(A, 3 * ONE_TOKEN);
  report("A contributes 3t", true, `vault ${tokens(await vaultBalance(vault))}`);

  await expectedError(
    "A tries +1t (5% further) -> rejected",
    "MaximumContributionsReached",
    () => contribute(A, ONE_TOKEN, true)
  );

  await expectedError(
    "A tries a refund while the window is open -> rejected",
    "FundraiserNotEnded",
    () =>
      program.methods
        .refund()
        .accountsPartial({
          contributor: A.keypair.publicKey,
          maker: maker.publicKey,
          mintToRaise: mint,
          fundraiser,
          contributorAccount: A.pda,
          contributorAta: A.ata,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([A.keypair])
        .rpc()
  );

  // ------------------------------------------------- 50% unlock
  console.log("\n--- filling the vault to exactly 50% ---");
  for (const c of [B, C, D, E]) {
    await contribute(c, 3 * ONE_TOKEN);
  }
  report(
    "B, C, D, E contribute 3t each",
    true,
    `vault ${tokens(await vaultBalance(vault))}`
  );

  console.log("\n--- tier 2 unlocks at 50% (cap 10% -> 20%) ---");
  await contribute(A, 3 * ONE_TOKEN);
  report("A contributes +3t (total 6t = 20%)", true, `vault ${tokens(await vaultBalance(vault))}`);

  await contribute(F, 4 * ONE_TOKEN);
  report(
    "F contributes a single 4t (over the old 10% cap)",
    true,
    `vault ${tokens(await vaultBalance(vault))}`
  );

  await expectedError(
    "F tries +3t (total 7t > 20% cap) -> rejected",
    "MaximumContributionsReached",
    () => contribute(F, 3 * ONE_TOKEN, true)
  );

  // ------------------------------------------------- tier 3
  console.log("\n--- tier 3 unlocks at 75% (cap sky-high, 30%) ---");
  await contribute(G, 4 * ONE_TOKEN);
  report("G contributes 4t", true, `vault ${tokens(await vaultBalance(vault))}`);

  await expectedError(
    "G tries +6t (total 10t > 30% cap) -> rejected",
    "MaximumContributionsReached",
    () => contribute(G, 6 * ONE_TOKEN, true)
  );

  await contribute(G, 5 * ONE_TOKEN);
  report(
    "G contributes +5t (total 9t = 30% cap, exactly)",
    true,
    `vault ${tokens(await vaultBalance(vault))}`
  );

  // ------------------------------------------------- sweep
  console.log("\n--- target reached, maker sweeps the pot ---");
  const makerAta = await ensureAta(maker.publicKey);
  const before = await vaultBalance(vault);
  await program.methods
    .checkContributions()
    .accountsPartial({
      maker: maker.publicKey,
      mintToRaise: mint,
      fundraiser,
      makerAta,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([maker])
    .rpc({ skipPreflight: true })
    .then(confirm);
  report(
    "maker withdraws the full vault",
    true,
    `vault ${tokens(before)} -> ${tokens(await vaultBalance(vault))}, ` +
      `maker holds ${tokens(
        (await connection.getTokenAccountBalance(makerAta)).value.amount
      )}`
  );

  let closed = false;
  try {
    await program.account.fundraiser.fetch(fundraiser);
  } catch {
    closed = true;
  }
  report("campaign state after sweep", closed, "fundraiser account closed");

  console.log("\n== demo complete ==");
  console.log("new everything is fresh: each run creates a new mint and campaign");
  console.log("wallets are lean: maker 0.05 SOL + 7 x 0.02 SOL per run");
  console.log("recovering leftover SOL back to the authority...");
  await sweepLeftoverSols();
}

main().catch(async (err) => {
  console.error("\ndemo failed:", err?.message ?? err);
  if (err?.logs?.length) {
    console.error("\nprogram logs:");
    for (const l of err.logs) console.error("  " + l);
  }
  console.error(err?.stack ?? "");
  console.error("\nrecovering leftover SOL back to the authority...");
  try {
    await sweepLeftoverSols();
  } catch (e) {
    console.error("recovery sweep failed:", e?.message ?? e);
  }
  process.exit(1);
});

// devnet RPCs sometimes fail with a hard 429 that escapes the promise chain
// entirely; reclaim the demo wallets' SOL before dying either way.
process.on("uncaughtException", async (err) => {
  console.error("\nuncaught exception:", err?.message ?? err);
  try {
    await sweepLeftoverSols();
  } catch (e) {
    console.error("recovery sweep failed:", e?.message ?? e);
  }
  process.exit(1);
});