/**
 * Who sits at the lab's table: four model-driven traders on existing seats, and ISSUER-B as a service.
 * Plan §2.2, §2.3, D4 and D22.
 *
 * A trader's seat is an implementation detail it is never told (`SEAT_OF`); what it sees is TRADER-n. The
 * loop's own lookups use seats, so the labels reach it through two small, tested seams: the loop's address
 * directory takes the labels as aliases (`LabHooks.aliases`) and the quote board names a buyer by its label
 * (`QuoteBoardOptions.displayName`).
 */
import type { Adapter } from "@touchstone/harness";
import type { ModelPrices } from "../budget/inference-cost.js";
import { LAB_ASSET_DESCRIPTION } from "./asset-text.js";
import { erc8004IdFor, type AgentId } from "../identity/resolve.js";
import type { RosterAgentConfig } from "../loop/full-run.js";
import type { ToolName } from "../tools/index.js";
import { buildLabBrief } from "./briefs.js";
import { ISSUER_SEAT, LAB_TRADERS, SEAT_OF, type Economy, type TraderLabel } from "./economy.js";
import { ISSUER_SERVICE_TOOLS, issuerServiceAdapter } from "./issuer-service.js";
import { FIXED_ROUTE_ORDER, type RouteOrder } from "./route-order.js";

/**
 * Anthropic only (instrument v9, D57): claude-haiku-4-5 on TRADER-1 and TRADER-3 and claude-sonnet-5 on TRADER-2 and TRADER-4, all direct, on the
 * Anthropic credit the Team plan provides. Two models on two seats each keeps the seat and the model separable. The point of the change is spend: the
 * daily print draws on OpenAI, xAI, Google and OpenRouter, and the lab no longer touches any of them.
 * History: through v4 the second family was gpt-5.4-mini, whose two seats stalled in the v4 rerun (D38); D39 put haiku on all four; D40-D42 seated
 * deepseek-v3.2 through OpenRouter, which ran out of credit mid-run in the first v6 run (D46); v7 (D47, D48) seated gpt-5.1 on TRADER-2 and grok-4.6 on
 * TRADER-4, both direct, and the one v8 run was made with them (D56). Neither is in the roster from v9.
 */
export const LAB_MODELS: Readonly<Record<TraderLabel, string>> = {
  "TRADER-1": "claude-haiku-4-5",
  "TRADER-2": "claude-sonnet-5",
  "TRADER-3": "claude-haiku-4-5",
  "TRADER-4": "claude-sonnet-5",
};

/**
 * A trader's whole grant. No `redeem_claim` (raw work is bought by quote, D8), no `reserve_for_work`, no `mint_claim` or
 * `pay_with_claim` (nothing is minted after the opening, D31), no `settle_escrow` (every payment is a direct transfer,
 * D30), no `check_headroom` and no `whoami`: the lab is not about capacity, and a tool it does not use is a tool an agent
 * may spend turns on. Three ways to pay: USDC, a held claim, or both (`settle_split_held`, shown as `pay_split`). No `get_print`
 * either (v6): it reads the published print, which is not the lab's — the print moves between rounds and each turn states it (D41).
 */
export const LAB_TRADER_TOOLS: readonly ToolName[] = [
  "request_quote",
  "issue_quote",
  "pay",
  "transfer_claim",
  "settle_split_held",
  "deliver_job",
  "get_balances",
];

export { LAB_ALIASES, labDisplayName } from "./economy.js";

export interface LabRosterInput {
  economy: Economy;
  print: { printId: string; rateUsdPerSiu: string };
  claim: { tokenId: string; classLabel: string; fromIso: string; untilIso: string };
  maxTurns: number;
  chain: string;
  rpcUrl: string;
  /** One adapter per trader; the runner builds them from the models below. */
  adapters: Readonly<Record<TraderLabel, Adapter>>;
  /** What each trader opens with, from the schedule and the highest print the walk can reach: stated in the brief. */
  opening: { fsiuMilliSiu: bigint; usdcMinor: bigint };
  /** The run's seeded order of routes and assets (D50). Defaults to the fixed order, for a test with no seed. */
  order?: RouteOrder;
  /** Prices to cost each model's turns at. */
  prices: Readonly<Record<string, ModelPrices>>;
  /** Defaults to `LAB_MODELS`. */
  models?: Readonly<Record<TraderLabel, string>>;
  /** Private keys and addresses by seat, for the four trader seats and ISSUER-B. */
  keys: Partial<Record<AgentId, string>>;
  addresses: Partial<Record<AgentId, string>>;
  /** The real provider a model is served by, for the per-provider spend report. */
  providerOf: (modelString: string) => string;
  /** The issuer's policy; defaults to the production one. Tests may substitute. */
  issuerAdapter?: Adapter;
}

const FREE_PRICES: ModelPrices = { priceInUsdPer1M: "0", priceOutUsdPer1M: "0" };

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`lab roster: no ${what}`);
  return value;
}

export function buildLabRoster(input: LabRosterInput): RosterAgentConfig[] {
  const models = input.models ?? LAB_MODELS;
  const addressOf = (seat: AgentId): string => required(input.addresses[seat], `address for ${seat}`);
  const keyOf = (seat: AgentId): string => required(input.keys[seat], `key for ${seat}`);

  const directory = {
    ...Object.fromEntries(
      LAB_TRADERS.map((t) => [t, { sellerId: erc8004IdFor(addressOf(SEAT_OF[t])), model: models[t] }]),
    ),
    ISSUER: { sellerId: erc8004IdFor(addressOf(ISSUER_SEAT)), model: "raw-work" },
  } as Parameters<typeof buildLabBrief>[0]["directory"];

  const traders: RosterAgentConfig[] = LAB_TRADERS.map((me) => {
    const seat = SEAT_OF[me];
    const modelString = models[me];
    return {
      agentId: seat,
      adapter: input.adapters[me],
      modelString,
      prices: required(input.prices[modelString], `price for ${modelString}`),
      skillPackText: buildLabBrief({
        me,
        economy: input.economy,
        print: input.print,
        opening: input.opening,
        order: input.order ?? FIXED_ROUTE_ORDER,
        address: addressOf(seat),
        directory,
        claim: input.claim,
        maxTurns: input.maxTurns,
        chain: input.chain,
      }),
      availableTools: LAB_TRADER_TOOLS,
      // Woken by a need that has opened, a request addressed to it or a payment; waiting costs nothing.
      waitsFor: "inbox" as const,
      privateKeyHex: keyOf(seat),
      address: addressOf(seat),
      erc8004Id: erc8004IdFor(addressOf(seat)),
      rpcUrl: input.rpcUrl,
      maxOutputTokens: 4500,
      // Measured on the first run: input about 6,000 tokens a turn, output 100 to 300 (maximum 305). Projecting the
      // full 4,500 made the spending cap fire at five times realized spend; 600 is about twice the observed maximum.
      projectedOutputTokens: 600,
      temperature: 0.7,
      provider: input.providerOf(modelString),
    };
  });

  const issuer: RosterAgentConfig = {
    agentId: ISSUER_SEAT,
    adapter: input.issuerAdapter ?? issuerServiceAdapter(),
    modelString: "issuer-service",
    prices: FREE_PRICES,
    // The validator checks every seat's text, the service's too. It reads no brief; it says what it is.
    skillPackText:
      `YOU ARE ${ISSUER_SEAT}, a service: it answers requests for raw work.\n\n` +
      LAB_ASSET_DESCRIPTION,
    availableTools: ISSUER_SERVICE_TOOLS,
    waitsFor: "inbox" as const,
    privateKeyHex: keyOf(ISSUER_SEAT),
    address: addressOf(ISSUER_SEAT),
    erc8004Id: erc8004IdFor(addressOf(ISSUER_SEAT)),
    rpcUrl: input.rpcUrl,
    maxOutputTokens: 1,
    temperature: 0,
    provider: "lab-service",
  };

  return [...traders, issuer];
}
