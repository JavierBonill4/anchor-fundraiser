export type Collaboration = { timestamp: number; amount: string };

export type BadgeJsonInput = {
  name: string;
  symbol: string;
  image: string;
  contributor: string;
  beneficiary: string;
  amount: string;
  position: number;
  collaborations: Collaboration[];
  mint?: string;
};

export function buildBadgeJson(input: BadgeJsonInput) {
  return {
    name: input.name,
    symbol: input.symbol,
    description: "Soulbound credential for a fundraiser contribution.",
    image: input.image,
    mint: input.mint,
    attributes: [
      { trait_type: "contributor", value: input.contributor },
      { trait_type: "beneficiary", value: input.beneficiary },
      { trait_type: "amount", value: input.amount },
      { trait_type: "position", value: String(input.position) },
    ],
    properties: { collaborations: input.collaborations },
  };
}
