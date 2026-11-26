import type { Print } from "@touchstone/sdk";
import {
  PAID_TOOL_PRICES_USD,
  SIU_PRICE_MAX_AGE_DAYS,
  commodityPrintCandidates,
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

/** static/mcp.json with every paid tool's price from the shared table, plus its mSIU figure. */
export function renderMcpJson(
  template: { tools?: McpJsonTool[]; [key: string]: unknown },
  siu: SiuPrices,
): string {
  const tools = (template.tools ?? []).map((tool) => {
    if (!isPaidTool(tool.name)) return tool;
    // Never carry a figure over from the template: the mSIU fields are rebuilt below, or left out.
    const out: McpJsonTool = { ...tool, price_usd: PAID_TOOL_PRICES_USD[tool.name] };
    delete out.price_msiu;
    delete out.siu_price;
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
  return `${JSON.stringify({ ...template, tools }, null, 2)}\n`;
}

/** static/.well-known/llms.txt with each `{{price:<tool>}}` filled in; an unknown tool fails the build. */
export function renderLlmsTxt(template: string, siu: SiuPrices): string {
  return template.replace(/\{\{price:([a-z_]+)\}\}/g, (_match, tool: string) => {
    if (tool !== "get_index" && !isPaidTool(tool)) {
      throw new Error(`llms.txt names an unknown tool in {{price:${tool}}}`);
    }
    return toolPriceLabel(tool, siu);
  });
}
