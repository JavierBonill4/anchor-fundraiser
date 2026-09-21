import * as anchor from "@coral-xyz/anchor";
import { BorshCoder, EventParser, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTokenMetadata,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Fundraiser } from "../target/types/fundraiser";
import { buildBadgeJson } from "./build-badge-json";
import { loadBadgeConfig, metadataUri } from "./load-config";
import { pinJsonToPinata } from "./pinata";

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function loadKeypair(keypairPath: string): anchor.web3.Keypair {
  const raw = fs.readFileSync(expandHome(keypairPath), "utf8");
  return anchor.web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

const FIXTURE_URI = "https://example.com/badge.json";

function log(msg: string, data?: Record<string, unknown>) {
  if (data) console.log(`[observer] ${msg}`, data);
  else console.log(`[observer] ${msg}`);
}

async function contributorsOnChain(
  program: Program<Fundraiser>,
  fundraiser: anchor.web3.PublicKey,
): Promise<Set<string>> {
  const accounts = await program.account.contributor.all([
    { memcmp: { offset: 8, bytes: fundraiser.toBase58() } },
  ]);
  return new Set(accounts.map((a) => a.account.contributor.toBase58()));
}

async function fetchMintedNft(
  connection: anchor.web3.Connection,
  badgeMint: anchor.web3.PublicKey,
  badgeAta: anchor.web3.PublicKey,
) {
  const [onchain, mintInfo, ata] = await Promise.all([
    getTokenMetadata(connection, badgeMint, "confirmed", TOKEN_2022_PROGRAM_ID),
    getMint(connection, badgeMint, "confirmed", TOKEN_2022_PROGRAM_ID),
    getAccount(connection, badgeAta, "confirmed", TOKEN_2022_PROGRAM_ID),
  ]);
  return {
    mint: badgeMint.toBase58(),
    ata: badgeAta.toBase58(),
    owner: ata.owner.toBase58(),
    amount: ata.amount.toString(),
    supply: mintInfo.supply.toString(),
    decimals: mintInfo.decimals,
    mintAuthority: mintInfo.mintAuthority?.toBase58() ?? null,
    freezeAuthority: mintInfo.freezeAuthority?.toBase58() ?? null,
    onchainMetadata: onchain
      ? {
          name: onchain.name,
          symbol: onchain.symbol,
          uri: onchain.uri,
          mint: onchain.mint.toString(),
          updateAuthority: onchain.updateAuthority?.toString() ?? null,
          additionalMetadata: onchain.additionalMetadata,
        }
      : null,
  };
}

export async function airdropOne(args: {
  program: Program<Fundraiser>;
  payer: anchor.web3.Keypair;
  fundraiser: anchor.web3.PublicKey;
  contributor: anchor.web3.PublicKey;
  uri: string;
}): Promise<string> {
  const badgeMint = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("badge"),
      args.fundraiser.toBuffer(),
      args.contributor.toBuffer(),
    ],
    args.program.programId,
  )[0];
  const contributorAccount = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("contributor"),
      args.fundraiser.toBuffer(),
      args.contributor.toBuffer(),
    ],
    args.program.programId,
  )[0];
  const badgeAta = getAssociatedTokenAddressSync(
    badgeMint,
    args.contributor,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  return args.program.methods
    .airdropBadge(args.uri)
    .accountsPartial({
      payer: args.payer.publicKey,
      contributor: args.contributor,
      fundraiser: args.fundraiser,
      contributorAccount,
      badgeMint,
      badgeAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([args.payer])
    .rpc();
}

async function handleClaimed(
  program: Program<Fundraiser>,
  payer: anchor.web3.Keypair,
  fundraiser: anchor.web3.PublicKey,
  contributors: Set<string>,
  config: ReturnType<typeof loadBadgeConfig>,
) {
  const campaign = await program.account.fundraiser.fetch(fundraiser);
  const onChain = await contributorsOnChain(program, fundraiser);
  const receivers = new Set([...contributors, ...onChain]);
  log("campaign claimed", {
    fundraiser: fundraiser.toBase58(),
    maker: campaign.maker.toBase58(),
    minter: campaign.minter.toBase58(),
    contributorCount: campaign.contributorCount,
    indexedFromEvents: contributors.size,
    loadedFromChain: onChain.size,
    willMint: receivers.size,
    raised: campaign.currentAmount.toString(),
    target: campaign.amountToRaise.toString(),
  });
  if (receivers.size === 0) {
    log("no contributors to mint for", { fundraiser: fundraiser.toBase58() });
    return;
  }

  for (const contrib of receivers) {
    const contributor = new anchor.web3.PublicKey(contrib);
    const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("contributor"),
        fundraiser.toBuffer(),
        contributor.toBuffer(),
      ],
      program.programId,
    );
    const account = await program.account.contributor.fetchNullable(pda);
    if (!account) {
      log("skip: no contributor pda", { receiver: contrib });
      continue;
    }
    if (account.badgeMinted) {
      log("skip: already minted", { receiver: contrib, position: account.position });
      continue;
    }

    const [badgeMint] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("badge"), fundraiser.toBuffer(), contributor.toBuffer()],
      program.programId,
    );
    const badgeAta = getAssociatedTokenAddressSync(
      badgeMint,
      contributor,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const json = buildBadgeJson({
      name: config.badgeName,
      symbol: config.badgeSymbol,
      image: config.badgeImageUri,
      contributor: contributor.toBase58(),
      beneficiary: campaign.maker.toBase58(),
      amount: account.amount.toString(),
      position: account.position,
      collaborations: account.collaborations.map((c) => ({
        timestamp: c.timestamp.toNumber(),
        amount: c.amount.toString(),
      })),
      mint: badgeMint.toBase58(),
    });

    let uri = FIXTURE_URI;
    if (config.pinataJwt) {
      log("pinning metadata", { receiver: contrib, position: account.position });
      const cid = await pinJsonToPinata({
        jwt: config.pinataJwt,
        name: `badge-${contributor.toBase58()}`,
        body: json,
      });
      uri = metadataUri(cid, config);
    } else {
      log("no PINATA_JWT, using fixture uri", { receiver: contrib, uri });
    }

    log("minting nft", {
      receiver: contributor.toBase58(),
      badgeMint: badgeMint.toBase58(),
      badgeAta: badgeAta.toBase58(),
      metadataUri: uri,
    });
    console.log(
      "[observer] off-chain metadata json\n" + JSON.stringify(json, null, 2),
    );

    const sig = await airdropOne({
      program,
      payer,
      fundraiser,
      contributor,
      uri,
    });
    const nft = await fetchMintedNft(
      program.provider.connection,
      badgeMint,
      badgeAta,
    );
    log("nft minted", {
      receiver: contributor.toBase58(),
      signature: sig,
      ...nft,
    });
  }
}

async function main() {
  const config = loadBadgeConfig(process.env, true);
  const payer = loadKeypair(config.airdropPayerKeypair);
  const connection = new anchor.web3.Connection(config.rpcUrl, {
    wsEndpoint: config.wsUrl,
    commitment: "confirmed",
  });
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(payer),
    {
      commitment: "confirmed",
    },
  );
  const idl = require("../target/idl/fundraiser.json");
  const program = new anchor.Program<Fundraiser>(idl, provider);
  const parser = new EventParser(
    program.programId,
    new BorshCoder(program.idl),
  );

  const index = new Map<string, Set<string>>();
  const claiming = new Set<string>();

  const crank = async (fundraiser: anchor.web3.PublicKey) => {
    const key = fundraiser.toBase58();
    if (claiming.has(key)) {
      log("skip duplicate claim tick", { fundraiser: key });
      return;
    }
    claiming.add(key);
    try {
      const known = index.get(key) ?? new Set<string>();
      await handleClaimed(program, payer, fundraiser, known, config);
    } finally {
      claiming.delete(key);
    }
  };

  log("listening", {
    program: program.programId.toBase58(),
    minter: payer.publicKey.toBase58(),
    rpc: config.rpcUrl,
    ws: config.wsUrl,
    image: config.badgeImageUri,
    pinata: Boolean(config.pinataJwt),
    uriScheme: config.badgeUriScheme,
  });

  connection.onLogs(program.programId, async (logs) => {
    try {
      for (const event of parser.parseLogs(logs.logs)) {
        const name = event.name;
        if (
          name === "contributionRecorded" ||
          name === "ContributionRecorded"
        ) {
          const fundraiser = (
            event.data.fundraiser as anchor.web3.PublicKey
          ).toBase58();
          const contributor = (
            event.data.contributor as anchor.web3.PublicKey
          ).toBase58();
          const set = index.get(fundraiser) ?? new Set<string>();
          set.add(contributor);
          index.set(fundraiser, set);
          log("contribution indexed", {
            fundraiser,
            receiver: contributor,
            amount: event.data.amount?.toString?.() ?? event.data.amount,
            position: event.data.position,
            knownForCampaign: set.size,
          });
        }
        if (name === "campaignClaimed" || name === "CampaignClaimed") {
          log("campaignClaimed event", {
            fundraiser: (
              event.data.fundraiser as anchor.web3.PublicKey
            ).toBase58(),
            maker: (event.data.maker as anchor.web3.PublicKey)?.toBase58?.(),
            contributorCount: event.data.contributorCount,
          });
          await crank(event.data.fundraiser as anchor.web3.PublicKey);
        }
        if (name === "badgeAirdropped" || name === "BadgeAirdropped") {
          log("BadgeAirdropped event", {
            fundraiser: (
              event.data.fundraiser as anchor.web3.PublicKey
            ).toBase58(),
            receiver: (
              event.data.contributor as anchor.web3.PublicKey
            ).toBase58(),
            badgeMint: (
              event.data.badgeMint as anchor.web3.PublicKey
            ).toBase58(),
            uri: event.data.uri,
          });
        }
      }
    } catch (err) {
      console.error("[observer] tick failed", err);
    }
  });

  const crankTarget =
    process.env.AIRDROP_FUNDRAISER ||
    process.argv.find((arg) => {
      try {
        return arg.length >= 32 && Boolean(new anchor.web3.PublicKey(arg));
      } catch {
        return false;
      }
    });
  if (crankTarget) {
    log("cranking existing fundraiser", { fundraiser: crankTarget });
    await crank(new anchor.web3.PublicKey(crankTarget));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
