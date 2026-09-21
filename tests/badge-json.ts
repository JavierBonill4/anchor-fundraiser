import { assert } from "chai";
import { buildBadgeJson } from "../scripts/build-badge-json";
import { loadBadgeConfig, metadataUri } from "../scripts/load-config";

describe("badge json", () => {
  it("copies contributor fields into Metaplex JSON", () => {
    const json = buildBadgeJson({
      name: "Solana Fall School Funding Credential",
      symbol: "SFSFUND",
      image: "ipfs://pngcid",
      contributor: "C1",
      beneficiary: "M1",
      amount: "2000000",
      position: 1,
      collaborations: [
        { timestamp: 1710000000, amount: "1000000" },
        { timestamp: 1710003600, amount: "1000000" },
      ],
      mint: "BadgeMint",
    });
    assert.strictEqual(json.image, "ipfs://pngcid");
    assert.strictEqual(
      json.attributes.find((a) => a.trait_type === "position")?.value,
      "1",
    );
    assert.strictEqual(json.properties.collaborations.length, 2);
  });

  it("does not require PINATA_JWT to build config", () => {
    const config = loadBadgeConfig({
      BADGE_IMAGE_URI: "ipfs://png",
    } as NodeJS.ProcessEnv);
    assert.isUndefined(config.pinataJwt);
    assert.strictEqual(metadataUri("abc", config), "ipfs://abc");
  });
});
