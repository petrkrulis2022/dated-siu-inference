import { Hono } from "hono";
import { createAdapterFor } from "@touchstone/harness";
import type { ModelRegistryEntry } from "@touchstone/sdk";
import { handleInferCore, type SellerDeps, type SellerOptions } from "../seller.js";
import { readEscrowUntilMatch, settle } from "../escrow-client.js";
import { clientsFor } from "../wallets.js";
import { DEMO_ILLUSTRATIVE_USD_PER_SIU, type PriceSnapshotEntryPrices } from "../pricing.js";

/**
 * The Arc Testnet seller Worker — the same seller logic `cli/demo.ts` already runs locally,
 * deployed as a persistent Cloudflare Worker instead of an ephemeral Express process. One source
 * file, deployed twice (wrangler.seller-a.jsonc / wrangler.seller-b.jsonc) with a different
 * MODEL_ID var and a different SELLER_PRIVATE_KEY secret each — not two near-duplicate files.
 *
 * `quote-log.ts` is deliberately not wired in here (it writes to node:fs, a "seller's own
 * process, own machine" console convenience per its own doc comment, not the payment protocol) —
 * `console.log` stands in for it, matching this repo's established Workers observability
 * pattern (mcp-server, chat-server).
 *
 * Model registry entries and price snapshot entries are inlined below rather than read from
 * data/registry/*.json at runtime (that's a Node fs read; a Worker has no repo checkout to read
 * from) — sourced from the real, current files as of 2026-09-05
 * (data/registry/models.json, data/registry/price-snapshot-merged-2026-09-03T01-01-04.946Z.json).
 * A registry change later needs a redeploy of this Worker to pick up, same tradeoff any
 * build-time-inlined config has.
 */

const MODELS: Record<string, { registryEntry: ModelRegistryEntry; prices: PriceSnapshotEntryPrices }> = {
  "mistral-small-3.2-24b-instruct": {
    registryEntry: {
      id: "mistral-small-3.2-24b-instruct",
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model_string: "mistralai/mistral-small-3.2-24b-instruct",
      tier: "open-weight-hosted",
      open_weights: true,
      host: "parasail",
      notes: "Cheapest-tier contrast point in the registry.",
    },
    prices: { price_in_usd_per_1m: "0.09", price_out_usd_per_1m: "0.3" },
  },
  "qwen-2.5-72b-instruct": {
    registryEntry: {
      id: "qwen-2.5-72b-instruct",
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model_string: "qwen/qwen-2.5-72b-instruct",
      tier: "open-weight-hosted",
      open_weights: true,
      host: "deepinfra",
      notes: "Catalog breadth: distinct model family from the seller-a cheap-tier pick.",
    },
    prices: { price_in_usd_per_1m: "0.36", price_out_usd_per_1m: "0.4" },
  },
};

// Same prompt/ceiling cli/demo.ts uses — sized so even the cheaper model clears
// TouchstoneEscrow's MIN_SETTLEMENT with real margin. See pricing.ts's own header comment for
// why both sellers quote the same illustrative rate.
const PROMPT =
  "Write a detailed, comprehensive explanation of how commodity benchmark price indices " +
  "work, using Dated Brent as a concrete example. Cover: what makes a reference price " +
  "trustworthy, how such indices are typically assembled and published on a rolling basis, " +
  "the difference between a spot assessment and a futures curve, how market participants " +
  "actually use the published number in real contracts, and at least two historical episodes " +
  "where the benchmark's mechanics mattered in practice. Use specific, concrete examples " +
  "throughout, and address counterarguments or edge cases where relevant. Aim for a thorough, " +
  "in-depth answer of at least 1400 words, organized into clearly labeled sections.";
const MAX_OUTPUT_TOKENS = 8000;
const QUOTE_TTL_SECONDS = 3600;

interface Env {
  CHAIN_NAME: string;
  RPC_URL: string;
  ESCROW_ADDRESS: string;
  MODEL_ID: string;
  SELLER_LABEL: string;
  SELLER_PRIVATE_KEY: string;
  OPENROUTER_API_KEY: string;
}

function optionsFor(env: Env): SellerOptions {
  const model = MODELS[env.MODEL_ID];
  if (!model) {
    throw new Error(`Unknown MODEL_ID "${env.MODEL_ID}" — expected one of: ${Object.keys(MODELS).join(", ")}`);
  }
  return {
    label: env.SELLER_LABEL,
    clients: clientsFor(env.SELLER_PRIVATE_KEY, env.RPC_URL),
    privateKeyHex: env.SELLER_PRIVATE_KEY,
    registryEntry: model.registryEntry,
    prices: model.prices,
    rateUsdPerSiu: DEMO_ILLUSTRATIVE_USD_PER_SIU,
    openrouterApiKey: env.OPENROUTER_API_KEY,
    escrowAddress: env.ESCROW_ADDRESS,
    chainName: env.CHAIN_NAME,
    prompt: PROMPT,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    quoteTtlSeconds: QUOTE_TTL_SECONDS,
    log: (line) => console.log(line),
  };
}

function depsFor(options: SellerOptions): SellerDeps {
  return {
    readEscrowUntilMatch,
    settle,
    logIssuedQuote: async (quote) => {
      console.log(`[${options.label}] issued quote ${quote.siu} SIU (cap ${quote.siu_max})`);
      return "console-only, not written anywhere — see this file's header comment on quote-log.ts";
    },
    adapter: createAdapterFor(options.registryEntry, { openrouter: options.openrouterApiKey }),
  };
}

const app = new Hono<{ Bindings: Env }>();

app.post("/infer", async (c) => {
  const options = optionsFor(c.env);
  const body = (await c.req.json().catch(() => undefined)) as { quote?: unknown } | undefined;
  try {
    const result = await handleInferCore(options, depsFor(options), body);
    return c.json(result.body as object, result.status as 200 | 400 | 402);
  } catch (err) {
    console.error(`[${options.label}] /infer failed:`, err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default app;
