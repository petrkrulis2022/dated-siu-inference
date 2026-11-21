/**
 * What a call costs, from the registry and the newest merged price snapshot: the same files the daily print reads, so the trial's dollars are priced as the print's are.
 * The cost itself is computed by the one shared function, @touchstone/sdk's callCostUsd (see usageCostUsd). All decimal strings; nothing here is a float.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { callCostUsd, type DecimalValue, type ModelRegistryEntry, type PriceSnapshot, type UsageConvention } from "@touchstone/sdk";
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

export class PriceNotFound extends Error {
  constructor(readonly modelId: string) {
    super(`no price for registry model "${modelId}" in the newest merged price snapshot`);
    this.name = "PriceNotFound";
  }
}

/** Models the trial runs that the print's registry does not hold (D124): a registry and a price list of their own, so the print's files are never edited for the trial. */
export const TRIAL_REGISTRY_DIR = join(REPO_ROOT, "data", "lab", "cr", "registry");

export class TrialRegistryOverlap extends Error {
  constructor(readonly modelId: string) {
    super(
      `"${modelId}" is in both the print's registry and the trial-only registry: the trial-only one is for models the print does not hold, so remove it there`,
    );
    this.name = "TrialRegistryOverlap";
  }
}

/**
 * The registry and the newest merged price snapshot under `dataRoot/registry`. Called with no `dataRoot` (the real run) it also reads the trial-only registry and prices in
 * `TRIAL_REGISTRY_DIR`, if present, and a model in both is an error: the print's entry is never shadowed.
 */
export function loadRegistryAndPrices(dataRoot?: string): {
  registry: ModelRegistryEntry[];
  snapshot: PriceSnapshot;
  snapshotFile: string;
} {
  const dir = join(dataRoot ?? join(REPO_ROOT, "data"), "registry");
  const registry = JSON.parse(
    readFileSync(join(dir, "models.json"), "utf-8"),
  ) as ModelRegistryEntry[];
  const latest = readdirSync(dir)
    .filter((f) => f.startsWith("price-snapshot-merged-") && f.endsWith(".json"))
    .sort()
    .at(-1);
  if (latest === undefined) throw new Error(`no merged price snapshot in ${dir}`);
  const snapshot = JSON.parse(readFileSync(join(dir, latest), "utf-8")) as PriceSnapshot;
  if (dataRoot !== undefined) return { registry, snapshot, snapshotFile: latest };
  return { ...withTrialOnly(registry, snapshot), snapshotFile: latest };
}

/** The print's registry and prices plus the trial-only ones; `dir` is a parameter so a test can point it at a temporary directory. */
export function withTrialOnly(
  registry: ModelRegistryEntry[],
  snapshot: PriceSnapshot,
  dir: string = TRIAL_REGISTRY_DIR,
): { registry: ModelRegistryEntry[]; snapshot: PriceSnapshot } {
  if (!existsSync(join(dir, "models.json"))) return { registry, snapshot };
  const extraModels = JSON.parse(
    readFileSync(join(dir, "models.json"), "utf-8"),
  ) as ModelRegistryEntry[];
  const extraPrices = JSON.parse(readFileSync(join(dir, "prices.json"), "utf-8")) as {
    entries: PriceSnapshot["entries"];
  };
  for (const id of [...extraModels.map((x) => x.id), ...extraPrices.entries.map((x) => x.model_id)])
    if (registry.some((r) => r.id === id) || snapshot.entries.some((e) => e.model_id === id))
      throw new TrialRegistryOverlap(id);
  return {
    registry: [...registry, ...extraModels],
    snapshot: { ...snapshot, entries: [...snapshot.entries, ...extraPrices.entries] },
  };
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
 * The dollar cost of a finished call, exact: the one shared cost function (@touchstone/sdk's callCostUsd), in the usage convention of the code
 * that recorded the counts. A call made through the harness adapters (runAnswer: the dry run and snapshot parts) follows
 * runRecordUsageConvention(provider); cr-lab's own chat loops (the MCP part and the economy runs) follow CHAT_LOOP_USAGE. Until 2026-11-21 this
 * was a copy of the formula that added cached tokens on top of a prompt count already holding them, for the trial's OpenRouter and OpenAI calls.
 */
/** A projection counts prompt and output only, so the convention does not change it; stated so the shared function is always called with one. */
const PROJECTION: UsageConvention = { cachedInsideInput: false, reasoningInsideOutput: true };

export function usageCostUsd(usage: UsageTokens, price: ModelPrice, convention: UsageConvention): DecimalValue {
  return callCostUsd(usage, price, convention);
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
    usageCostUsd({ input: approxInputTokens, output: out, cached_input: 0, reasoning: 0 }, price, PROJECTION);
  return attempt(maxOutputTokens).plus(attempt(maxOutputTokens * retryMultiple));
}

/** The most one MCP-mode turn could cost, reserved before it is made: the whole conversation so far as input plus the full output allowance. */
export function projectedTurnCostUsd(approxInputTokens: number, maxOutputTokens: number, price: ModelPrice): DecimalValue {
  return usageCostUsd({ input: approxInputTokens, output: maxOutputTokens, cached_input: 0, reasoning: 0 }, price, PROJECTION);
}
