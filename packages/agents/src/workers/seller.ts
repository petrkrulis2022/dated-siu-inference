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
 * (data/registry/models.json, data/registry/price-snapshot-merged-2026-09-03T01-01-04.946Z.json),
 * except gpt-5.4-mini's price, sourced from the most recent snapshot as of 2026-09-06
 * (data/registry/price-snapshot-litellm-2026-09-06T01-05-07.104Z.json) when it was added.
 * A registry change later needs a redeploy of this Worker to pick up, same tradeoff any
 * build-time-inlined config has.
 *
 * seller-b deliberately quotes a frontier-tier model (gpt-5.4-mini) against seller-a's
 * open-weight one, not a second open-weight model at a different host: a same-tier spread (the
 * mistral-small/qwen-2.5-72b pairing this replaced) sits within the range a buyer could plausibly
 * guess from headline token prices alone ($0.30 vs $0.40 output — no unit of account needed to
 * arrive at roughly the same answer). The comparison only earns its keep when the naive
 * token-price answer and the measured cost-per-unit-of-work answer can diverge — which is what a
 * frontier-versus-commodity spread is for.
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
      notes: "Catalog breadth: distinct model family from the seller-a cheap-tier pick. No longer deployed as seller-b (see gpt-5.4-mini below) — kept here as a catalog entry, available to reconfigure MODEL_ID back to if ever needed.",
    },
    prices: { price_in_usd_per_1m: "0.36", price_out_usd_per_1m: "0.4" },
  },
  "gpt-5.4-mini": {
    registryEntry: {
      id: "gpt-5.4-mini",
      provider: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
      model_string: "gpt-5.4-mini",
      tier: "frontier",
      open_weights: false,
      host: "openai",
      notes: "Frontier-tier contrast point for seller-b, replacing qwen-2.5-72b-instruct — see this file's header comment for why a same-tier open-weight pairing doesn't demonstrate the argument.",
    },
    prices: { price_in_usd_per_1m: "0.75", price_out_usd_per_1m: "4.5" },
  },
};

// Resized three times now, every time against real (not point-estimate) settlement, not
// arithmetic — this design's own stated $0.001-$0.10 target range is a real constraint that
// shaped the demo: v1 ("≥1400 words", soft aggregate count) settled mistral-small at $0.000544 —
// clears TouchstoneEscrow's MIN_SETTLEMENT (100 minor units, $0.0001) with real margin, but under
// $0.001. v2 ("≥2800 words", still a soft aggregate count) only grew real output ~23%
// (1761→~2160 tokens) to $0.000648 — still under $0.001: a single soft word-count target doesn't
// reliably move a smaller open-weight model's real output the way it moves a point estimate. v3
// (an explicit 8-section, ≥400-words-each structure — a model tracking "have I written section 6
// of 8 yet" complies more reliably than one tracking a running word count) got real output to
// ~3050 tokens, settling at $0.000917 — much closer, still just under $0.001. v4 (this version)
// raises the per-section minimum to 550 words for more headroom. Confirm live after any future
// change here too — this whole history is the point: the floor is a real constraint that shaped
// the demo, not a number in a spec.
const PROMPT =
  "Write an exhaustive explanation of how commodity benchmark price indices work, using Dated " +
  "Brent as a concrete example. Structure your answer as exactly eight clearly labeled sections, " +
  "each at least 550 words: (1) what makes a reference price trustworthy, (2) how such indices " +
  "are typically assembled, (3) how they are published on a rolling basis, (4) the difference " +
  "between a spot assessment and a futures curve, (5) how market participants use the published " +
  "number in real contracts, (6) a first historical episode where the benchmark's mechanics " +
  "mattered in practice, explained in full narrative detail, (7) a second, different historical " +
  "episode explained the same way, and (8) counterarguments or edge cases against the benchmark's " +
  "reliability, with a concrete rebuttal to each. Use specific, concrete examples throughout. Do " +
  "not summarize sections briefly — each of the eight must independently satisfy its own " +
  "550-word minimum.";
// Raised from 8000 after a live run measured gpt-5.4-mini's real output at 7574 tokens — within
// ~5% of that ceiling, a real risk of silent truncation on a future run that happens to run
// slightly longer. This does move both sellers' point-estimate/cap quote (estimatedCeiling's
// point estimate is half of this value) — confirmed live after this change, same as every other
// resize here.
const MAX_OUTPUT_TOKENS = 11000;
const QUOTE_TTL_SECONDS = 3600;

interface Env {
  CHAIN_NAME: string;
  RPC_URL: string;
  ESCROW_ADDRESS: string;
  MODEL_ID: string;
  SELLER_LABEL: string;
  SELLER_PRIVATE_KEY: string;
  /** Only the key this deployment's own MODEL_ID actually needs has to be a real secret — the
   * other is simply unset. Both declared optional here since this one source file is deployed
   * against different providers per seller (see this file's header comment). */
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
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
    apiKeys: { openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY },
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
    // Same reasoning as logIssuedQuote above: agent-run-log.ts's real implementation writes to
    // node:fs, unavailable from a Worker with no repo checkout to write into. This Worker's real
    // transactions are exactly the ones the telemetry gap matters most for (they're live, real
    // Arc/Base-Sepolia settlements) — console.log is a stopgap visibility measure, not a
    // substitute for the git-tracked data/agent-runs/ record a Node-run seller produces.
    logAgentRun: async (record) => {
      console.log(
        `[${options.label}] agent-run: role=${record.role} model=${record.model} ` +
          `retry_count=${record.retry_count} usdc_paid=$${record.usdc_paid} quote_hash=${record.quote_hash}`,
      );
      return "console-only, not written anywhere — see this file's header comment.";
    },
    adapter: createAdapterFor(options.registryEntry, options.apiKeys),
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
