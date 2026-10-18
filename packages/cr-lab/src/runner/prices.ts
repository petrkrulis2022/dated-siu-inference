/**
 * What a call costs, from the registry and the newest merged price snapshot: the same files the daily print reads, so the trial's dollars are priced as the print's are.
 * Cost = input / 1e6 x price in + (output + reasoning) / 1e6 x price out (+ cached / 1e6 x cached price where the snapshot has one): reasoning tokens are billed at the output rate,
 * as the print does (`packages/print/src/compute/class-cost.ts`). All decimal strings; nothing here is a float.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { D, type DecimalValue, type ModelRegistryEntry, type PriceSnapshot } from "@touchstone/sdk";
import { REPO_ROOT } from "../paths.js";

export interface ModelPrice {
  priceInUsdPer1M: string;
  priceOutUsdPer1M: string;
  priceCachedInUsdPer1M?: string;
}

export interface UsageTokens {
  input: number;
  output: number;
  cached_input: number;
  reasoning: number;
}

const MILLION = new D(1_000_000);

export class PriceNotFound extends Error {
  constructor(readonly modelId: string) {
    super(`no price for registry model "${modelId}" in the newest merged price snapshot`);
    this.name = "PriceNotFound";
  }
}

/** The registry and the newest merged price snapshot under `dataRoot/registry`. */
export function loadRegistryAndPrices(dataRoot: string = join(REPO_ROOT, "data")): {
  registry: ModelRegistryEntry[];
  snapshot: PriceSnapshot;
  snapshotFile: string;
} {
  const dir = join(dataRoot, "registry");
  const registry = JSON.parse(
    readFileSync(join(dir, "models.json"), "utf-8"),
  ) as ModelRegistryEntry[];
  const latest = readdirSync(dir)
    .filter((f) => f.startsWith("price-snapshot-merged-") && f.endsWith(".json"))
    .sort()
    .at(-1);
  if (latest === undefined) throw new Error(`no merged price snapshot in ${dir}`);
  const snapshot = JSON.parse(readFileSync(join(dir, latest), "utf-8")) as PriceSnapshot;
  return { registry, snapshot, snapshotFile: latest };
}

export function priceFor(modelId: string, snapshot: PriceSnapshot): ModelPrice {
  const e = snapshot.entries.find((x) => x.model_id === modelId);
  if (e === undefined) throw new PriceNotFound(modelId);
  const cached = (e as { price_cached_in_usd_per_1m?: string }).price_cached_in_usd_per_1m;
  return {
    priceInUsdPer1M: e.price_in_usd_per_1m,
    priceOutUsdPer1M: e.price_out_usd_per_1m,
    ...(cached !== undefined ? { priceCachedInUsdPer1M: cached } : {}),
  };
}

/**
 * Whether the provider's reported `output` ALREADY contains its reasoning tokens, so that adding `reasoning` would bill them twice.
 *  - anthropic: yes. Verified on the first live dry run (2026-10-17): on every call the thinking tokens were fewer than the output tokens, and the difference was the size of the JSON answer
 *    (a call with 20,324 thinking tokens reported 21,067 output tokens; the answer itself was about 740). The print never sees this: its Claude runs report 0 reasoning tokens.
 *  - every other provider: not established for the trial. The print adds reasoning to output for them (Google and xAI report it separately, confirmed there), so the trial does the same,
 *    which can only over-count, never under-count; the B5 smoke test per provider must check this before any of them is funded.
 */
export const REASONING_IN_OUTPUT: Readonly<Record<string, boolean>> = { anthropic: true };

/** The dollar cost of a finished call, exact. Reasoning tokens are billed at the output rate; they are added only where the provider reports them apart from `output`. */
export function usageCostUsd(
  usage: UsageTokens,
  price: ModelPrice,
  provider?: string,
): DecimalValue {
  const outputTokens =
    provider !== undefined && REASONING_IN_OUTPUT[provider] === true
      ? usage.output
      : usage.output + usage.reasoning;
  let total = new D(usage.input)
    .div(MILLION)
    .times(price.priceInUsdPer1M)
    .plus(new D(outputTokens).div(MILLION).times(price.priceOutUsdPer1M));
  if (usage.cached_input > 0 && price.priceCachedInUsdPer1M !== undefined)
    total = total.plus(new D(usage.cached_input).div(MILLION).times(price.priceCachedInUsdPer1M));
  return total;
}

/**
 * The most a call could cost, reserved against the cap BEFORE it is made: the prompt at its rough size plus the full output allowance, plus one more attempt at the larger budget
 * the adapters retry with when mandatory reasoning truncates a reply (`REASONING_BUDGET_MULTIPLE`). Deliberately generous: a high projection only means a call is refused a little
 * sooner near a limit, never that the limit is crossed.
 */
export function projectedCostUsd(
  approxInputTokens: number,
  maxOutputTokens: number,
  retryMultiple: number,
  price: ModelPrice,
): DecimalValue {
  const attempt = (out: number) =>
    usageCostUsd({ input: approxInputTokens, output: out, cached_input: 0, reasoning: 0 }, price);
  return attempt(maxOutputTokens).plus(attempt(maxOutputTokens * retryMultiple));
}

/** The most one MCP-mode turn could cost, reserved before it is made: the whole conversation so far as input plus the full output allowance. */
export function projectedTurnCostUsd(
  approxInputTokens: number,
  maxOutputTokens: number,
  price: ModelPrice,
  provider?: string,
): DecimalValue {
  return usageCostUsd(
    { input: approxInputTokens, output: maxOutputTokens, cached_input: 0, reasoning: 0 },
    price,
    provider,
  );
}
