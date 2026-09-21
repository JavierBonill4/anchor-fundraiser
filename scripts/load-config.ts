import { config as loadDotenv } from "dotenv";

export type BadgeUriScheme = "ipfs" | "gateway";

export type BadgeConfig = {
  rpcUrl: string;
  wsUrl: string;
  badgeImageUri: string;
  pinataJwt: string | undefined;
  pinataGatewayUrl: string;
  badgeUriScheme: BadgeUriScheme;
  airdropPayerKeypair: string;
  badgeName: string;
  badgeSymbol: string;
};

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value && value.length > 0 ? value : undefined;
}

export function loadBadgeConfig(
  env: NodeJS.ProcessEnv = process.env,
  requireObserverSecrets = false,
): BadgeConfig {
  if (env === process.env) loadDotenv();
  const scheme = (readEnv(env, "BADGE_URI_SCHEME") ?? "ipfs") as BadgeUriScheme;
  if (scheme !== "ipfs" && scheme !== "gateway") {
    throw new Error(`BADGE_URI_SCHEME must be ipfs or gateway, got ${scheme}`);
  }

  const config: BadgeConfig = {
    rpcUrl: readEnv(env, "SOLANA_RPC_URL") ?? "http://127.0.0.1:8899",
    wsUrl: readEnv(env, "SOLANA_WS_URL") ?? "ws://127.0.0.1:8900",
    badgeImageUri: readEnv(env, "BADGE_IMAGE_URI") ?? "",
    pinataJwt: readEnv(env, "PINATA_JWT"),
    pinataGatewayUrl:
      readEnv(env, "PINATA_GATEWAY_URL") ?? "https://gateway.pinata.cloud",
    badgeUriScheme: scheme,
    airdropPayerKeypair:
      readEnv(env, "AIRDROP_PAYER_KEYPAIR") ?? "~/.config/solana/id.json",
    badgeName:
      readEnv(env, "BADGE_NAME") ?? "Solana Fall School Funding Credential",
    badgeSymbol: readEnv(env, "BADGE_SYMBOL") ?? "SFSFUND",
  };

  if (requireObserverSecrets && !config.badgeImageUri) {
    throw new Error("BADGE_IMAGE_URI is required for the live observer");
  }

  return config;
}

export function metadataUri(jsonCid: string, config: BadgeConfig): string {
  if (config.badgeUriScheme === "gateway") {
    return `${config.pinataGatewayUrl.replace(/\/$/, "")}/ipfs/${jsonCid}`;
  }
  return `ipfs://${jsonCid}`;
}
