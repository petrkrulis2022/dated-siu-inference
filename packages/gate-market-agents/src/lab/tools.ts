/**
 * What the lab calls its payment tools, and what each says about itself.
 *
 * The first model run found that the names were doing the choosing: a trader read `pay_with_claim` as "pay with the
 * claim I hold" and called it 27 times, 24 of them refused for want of USDC, while the route that does spend a held
 * claim was never tried once. Models read a name before a description, so each name here says what the route does, in the
 * same form as the others, and each description has the same shape: what it does, then what it costs (D26).
 *
 * From instrument v4 there are three, and all three are direct transfers to the seller at the moment of payment (D30):
 * USDC, a claim the trader holds, or both. Nothing is minted after the opening (D31).
 *
 * The loop still runs its own tools. A trader calls `pay_with_usdc`; `resolveLabCall` turns that into the `pay` call, and the
 * trader's history shows the call it made. An internal name an agent was not given is refused.
 */
import type { ToolName } from "../tools/index.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The name each internal payment tool has for a lab trader. */
export const LAB_TOOL_NAMES: Readonly<Partial<Record<ToolName, string>>> = {
  pay: "pay_with_usdc",
  transfer_claim: "pay_with_held_claim",
  settle_split_held: "pay_split",
};

/** Internal payment tools a lab trader is never given, whose names are refused if one is called. */
const RETIRED_INTERNAL: readonly string[] = ["pay_with_claim", "settle_split", "settle_escrow"];

const INTERNAL_OF: Readonly<Record<string, ToolName>> = Object.fromEntries(
  Object.entries(LAB_TOOL_NAMES).map(([internal, shown]) => [shown, internal as ToolName]),
);

/** The three, in one shape: what it settles and how, then what it costs. */
export const LAB_TOOL_DESCRIPTIONS: Readonly<Partial<Record<ToolName, string>>> = {
  pay:
    "pay_with_usdc(requestId) -> settles a quote you were sent by giving the seller USDC, at once. Costs: the quote's " +
    "price, in USDC.",
  transfer_claim:
    "pay_with_held_claim(requestId) -> settles a quote you were sent by giving the seller a claim you already hold, at " +
    "once, worth the quote's price at the print of the round the quote was asked for in. Costs: that claim's fSIU.",
  settle_split_held:
    "pay_split(requestId, claimQuantityMilliSiu) -> settles a quote you were sent by giving the seller, at once, a claim " +
    "you already hold of the quantity you give, valued at the print of the round the quote was asked for in, and the rest " +
    "of the quote's price in USDC. Costs: that quantity of fSIU, plus the rest of the quote's price in USDC.",
};

export interface CallLookup {
  /** The name a call to the seller of this quote uses (a trader's label, or the issuer's), or undefined if there is no such quote. */
  sellerNameOf(requestId: string): string | undefined;
  /** The one token every trader holds. */
  tokenId: string;
  /** What the current round's print is called in a quote's `print_id` (D41); undefined where the lab has no print path. */
  printIdNow?(): string | undefined;
}

/** `undefined` for a tool that was not renamed; a refusal for an internal name the agent was not given. */
export function resolveLabCall(
  lookup: CallLookup,
  name: string,
  args: unknown,
): { tool: ToolName; args: unknown } | { refuse: string } | undefined {
  if ((Object.keys(LAB_TOOL_NAMES) as string[]).includes(name) || RETIRED_INTERNAL.includes(name)) {
    return { refuse: `${name} is not one of your tools.` };
  }
  // A quote request names the print of the round it is asked in. The agent copies a print id from its brief, which names round 1's;
  // the lab writes the current round's, so a later round's quote carries its own scenario print and not the published one (D41).
  if (name === "request_quote") {
    const now = lookup.printIdNow?.();
    return now === undefined || typeof args !== "object" || args === null ? undefined : { tool: "request_quote", args: { ...(args as object), printId: now } };
  }
  // Not renamed, but the loop fills in arguments the agent never gave it: a list of escrows to read, for one. Resolved to
  // itself so the agent's history shows `get_balances` exactly as it called it, and names no escrow it never heard of.
  if (name === "get_balances") return { tool: "get_balances", args: args ?? {} };
  const tool = INTERNAL_OF[name];
  if (tool === undefined) return undefined;
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "pay":
      // Called by the quote alone; the settler is the zero address, as everywhere in this lab (a direct payment has none).
      return { tool, args: { ...a, settler: a.settler ?? ZERO_ADDRESS } };
    case "transfer_claim": {
      const id = a.requestId;
      if (typeof id !== "string") return { tool, args: a };
      const seller = lookup.sellerNameOf(id);
      if (seller === undefined) return { refuse: `there is no quote ${id}.` };
      return { tool, args: { agentId: seller, tokenId: lookup.tokenId, requestId: id } };
    }
    case "settle_split_held": {
      const id = a.requestId;
      if (typeof id !== "string") return { tool, args: a };
      if (lookup.sellerNameOf(id) === undefined) return { refuse: `there is no quote ${id}.` };
      return { tool, args: { ...a, tokenId: lookup.tokenId } };
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
