/**
 * What the lab calls its payment tools, and what each says about itself.
 *
 * The first model run found that the names were doing the choosing. The loop's tool for minting a claim to pay
 * with is called `pay_with_claim`, and a trader read that as "pay with the claim I hold": it called it 27 times,
 * 24 of them refused for want of USDC, while the route that does spend a held claim — `transfer_claim` — was never
 * tried once, and that is the route the primary measure counts. Models read a name before a description, so each name
 * here says what the route does, in the same form as the others, and each description has the same shape: what it does,
 * then what it costs (D26).
 *
 * The loop still runs its own tools. A trader calls `pay_with_new_claim`; `resolveLabCall` turns that into the
 * `pay_with_claim` call, and the trader's history shows the call it made. The names an agent was not given are refused.
 */
import type { ToolName } from "../tools/index.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The name each internal payment tool has for a lab trader. */
export const LAB_TOOL_NAMES: Readonly<Partial<Record<ToolName, string>>> = {
  pay: "pay_with_usdc",
  pay_with_claim: "pay_with_new_claim",
  transfer_claim: "pay_with_held_claim",
  settle_split: "pay_split",
};

const INTERNAL_OF: Readonly<Record<string, ToolName>> = Object.fromEntries(
  Object.entries(LAB_TOOL_NAMES).map(([internal, shown]) => [shown, internal as ToolName]),
);

/** The four, in one shape: what it settles and how, then what it costs. */
export const LAB_TOOL_DESCRIPTIONS: Readonly<Partial<Record<ToolName, string>>> = {
  pay:
    "pay_with_usdc(requestId) -> settles a quote you were sent by giving the seller USDC, held in escrow until the " +
    "seller releases it. Costs: the quote's price, in USDC.",
  pay_with_claim:
    "pay_with_new_claim(requestId) -> settles a quote you were sent by giving the seller a newly minted claim worth " +
    "the quote's price at the print. Costs: the mint price of that claim, in USDC, at the print, paid to the issuer.",
  transfer_claim:
    "pay_with_held_claim(requestId) -> settles a quote you were sent by giving the seller a claim you already hold, " +
    "worth the quote's price at the print. Costs: that claim's fSIU.",
  settle_split:
    "pay_split(requestId, claimQuantityMilliSiu) -> settles a quote you were sent partly with a newly minted claim of " +
    "the quantity you give and the rest in USDC. Costs: the mint price of that claim in USDC, at the print, paid to " +
    "the issuer, plus the rest of the quote's price in USDC.",
};

export interface CallLookup {
  /** The name a call to the seller of this quote uses (a trader's label, or the issuer's), or undefined if there is no such quote. */
  sellerNameOf(requestId: string): string | undefined;
  /** The one token every trader holds. */
  tokenId: string;
}

/** `undefined` for a tool that was not renamed; a refusal for an internal name the agent was not given. */
export function resolveLabCall(
  lookup: CallLookup,
  name: string,
  args: unknown,
): { tool: ToolName; args: unknown } | { refuse: string } | undefined {
  if ((Object.keys(LAB_TOOL_NAMES) as string[]).includes(name)) return { refuse: `${name} is not one of your tools.` };
  const tool = INTERNAL_OF[name];
  if (tool === undefined) return undefined;
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "pay":
    case "settle_split":
      // Every route is called by the quote alone; the settler is the zero address, as everywhere in this lab.
      return { tool, args: { ...a, settler: a.settler ?? ZERO_ADDRESS } };
    case "pay_with_claim":
      return { tool, args: a };
    case "transfer_claim": {
      const id = a.requestId;
      if (typeof id !== "string") return { tool, args: a };
      const seller = lookup.sellerNameOf(id);
      if (seller === undefined) return { refuse: `there is no quote ${id}.` };
      return { tool, args: { agentId: seller, tokenId: lookup.tokenId, requestId: id } };
    }
    default:
      return undefined;
  }
}

/** An internal tool name inside a sentence (an error), written as the agent knows it. */
export function rewriteLabText(text: string): string {
  let out = text;
  for (const [internal, shown] of Object.entries(LAB_TOOL_NAMES)) {
    if (internal === "pay") out = out.replace(/\bpay(?=:)/g, shown);
    else out = out.replace(new RegExp(`\\b${internal}\\b`, "g"), shown);
  }
  return out;
}
