import type { Print } from "@touchstone/sdk";
import {
  MAINNET_PAYMENT_NETWORKS,
  MAINNET_UNAVAILABLE_NOTES,
  PAID_TOOL_PRICES_USD,
  PAYMENT_ROUTE,
  SIU_PRICE_DOCS_URL,
  SIU_PRICE_MAX_AGE_DAYS,
  commodityPrintCandidates,
  paymentNetworksText,
  priceLabel,
  siuPriceFor,
  type PaidTool,
  type SiuPrice,
} from "@touchstone/print";

/**
 * The paid tools' prices on the site's agent-facing pages (mcp.json, llms.txt, the for-agents
 * page), from the one table the server's paywall also reads (@touchstone/print's siu-price.ts).
 * The site rebuilds on every push, including each day's print commit, so the mSIU figures follow
 * the daily print.
 */
export type SiuPrices = Partial<Record<PaidTool, SiuPrice | undefined>>;

const PAID_TOOLS = Object.keys(PAID_TOOL_PRICES_USD) as PaidTool[];
const isPaidTool = (name: string): name is PaidTool => Object.hasOwn(PAID_TOOL_PRICES_USD, name);

/** Each paid tool's SIU price at the newest Commodity print that nothing supersedes. */
export function siuPricesFromPrints(prints: readonly Print[], now: Date): SiuPrices {
  const byId = new Map(prints.map((p) => [p.print_id, p]));
  let print: Print | undefined;
  for (const id of commodityPrintCandidates([...byId.keys()])) {
    const candidate = byId.get(id);
    if (candidate && !(candidate as { superseded_by?: unknown }).superseded_by) {
      print = candidate;
      break;
    }
  }
  return Object.fromEntries(
    PAID_TOOLS.map((tool) => [tool, siuPriceFor(PAID_TOOL_PRICES_USD[tool], print, now)]),
  );
}

/** "free" for get_index; the shared price label for a paid tool. */
export function toolPriceLabel(tool: string, siu: SiuPrices): string {
  return isPaidTool(tool) ? priceLabel(PAID_TOOL_PRICES_USD[tool], siu[tool]) : "free";
}

const SIU_RULE =
  `Comparison price only; payment is the USDC amount. Follows the daily print, and is omitted ` +
  `when the latest Commodity print is more than ${SIU_PRICE_MAX_AGE_DAYS} days old.`;

interface McpJsonTool {
  name: string;
  price_usd?: string;
  price_msiu?: string;
  siu_price?: unknown;
  [key: string]: unknown;
}

/** How payment works, stated from the shared facts (@touchstone/print's paid-tools.ts). */
function paymentBlock() {
  return {
    networks: MAINNET_PAYMENT_NETWORKS.map((n) => ({
      name: n.name,
      eip155: n.caip2,
      asset: n.asset,
      address: n.assetAddress,
    })),
    route: PAYMENT_ROUTE,
    siu_price: {
      where: "Each 402 payment offer also carries the price in mSIU, in extra.touchstone.",
      docs: SIU_PRICE_DOCS_URL,
    },
  };
}

/**
 * static/mcp.json with how payment works and every paid tool's price from the shared sources, plus
 * its mSIU figure. Any `network`/`settlement` block left in the template is dropped: the networks
 * stated are always exactly the ones the server's mainnet profile accepts.
 */
export function renderMcpJson(
  template: { tools?: McpJsonTool[]; [key: string]: unknown },
  siu: SiuPrices,
): string {
  const { network: _network, settlement: _settlement, ...rest } = template;
  void _network;
  void _settlement;
  const tools = (template.tools ?? []).map((tool) => {
    if (!isPaidTool(tool.name)) return tool;
    // Never carry a figure over from the template: the mSIU fields are rebuilt below, or left out.
    const out: McpJsonTool = { ...tool, price_usd: PAID_TOOL_PRICES_USD[tool.name] };
    delete out.price_msiu;
    delete out.siu_price;
    delete out.mainnet_note;
    const note = MAINNET_UNAVAILABLE_NOTES[tool.name];
    out.available_on_mainnet = note === undefined;
    if (note) out.mainnet_note = note;
    const price = siu[tool.name];
    if (price) {
      out.price_msiu = price.price_msiu;
      out.siu_price = {
        grade: price.grade,
        rate_usd_per_siu: price.rate_usd_per_siu,
        print_id: price.print_id,
        print_date: price.print_date,
        rule: SIU_RULE,
      };
    }
    return out;
  });
  return `${JSON.stringify({ ...rest, payment: paymentBlock(), tools }, null, 2)}\n`;
}

/**
 * static/.well-known/llms.txt with its placeholders filled from the shared sources:
 * `{{price:<tool>}}`, `{{payment_networks}}`, `{{siu_price_docs}}` and `{{mainnet_note:<tool>}}`.
 * An unknown placeholder, or a mainnet note for a tool that has none, fails the build.
 */
export function renderLlmsTxt(template: string, siu: SiuPrices): string {
  return template.replace(
    /\{\{([a-z_]+)(?::([a-z_]+))?\}\}/g,
    (match, key: string, arg: string | undefined) => {
      if (key === "price" && arg !== undefined && (arg === "get_index" || isPaidTool(arg))) {
        return toolPriceLabel(arg, siu);
      }
      if (key === "payment_networks" && arg === undefined) return paymentNetworksText();
      if (key === "siu_price_docs" && arg === undefined) return SIU_PRICE_DOCS_URL;
      if (key === "mainnet_note" && arg !== undefined && isPaidTool(arg)) {
        const note = MAINNET_UNAVAILABLE_NOTES[arg];
        if (note) return note;
      }
      throw new Error(`llms.txt has a placeholder this build cannot fill: ${match}`);
    },
  );
}
