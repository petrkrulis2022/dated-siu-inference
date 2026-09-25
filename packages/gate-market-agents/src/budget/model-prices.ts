import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRegistryEntry, PriceSnapshot } from "@touchstone/sdk";
import type { ModelPrices } from "./inference-cost.js";

/**
 * Every CLI entry point before WP-7 (`smoke-pass.ts`, `gate-authoring-pass.ts`,
 * `code-gate-authoring-pass.ts`) hardcoded its one model's `ModelPrices` as a manually-copied
 * constant, citing which registry snapshot it came from in a comment. That was fine for one
 * model per script; six agents that can each carry a different `reasoning_model` (and issuers a
 * separate `capacity_model`, spec §12.2a) need a real lookup instead of six more hand-copied
 * constants that silently drift from the registry the moment a price actually moves.
 */
export class ModelPriceNotFoundError extends Error {
  constructor(public readonly modelId: string) {
    super(
      `No price snapshot entry for registry model id "${modelId}" — check ` +
        `data/registry/models.json's own id spelling and that a merged price snapshot exists.`,
    );
    this.name = "ModelPriceNotFoundError";
  }
}

/** Pure — the actual lookup, given already-loaded registry/snapshot data. Throws rather than
 * guessing, matching this package's own `pack/validate.ts` "throws, never warns" convention: a
 * six-agent run with a silently-wrong price is a real-dollar mistake, not a warning-worthy one. */
export function modelPricesFor(
  modelId: string,
  registry: readonly ModelRegistryEntry[],
  snapshot: PriceSnapshot,
): ModelPrices {
  const entry = registry.find((r) => r.id === modelId);
  if (!entry) throw new ModelPriceNotFoundError(modelId);
  const priced = snapshot.entries.find((e) => e.model_id === modelId);
  if (!priced) throw new ModelPriceNotFoundError(modelId);
  return {
    priceInUsdPer1M: priced.price_in_usd_per_1m,
    priceOutUsdPer1M: priced.price_out_usd_per_1m,
  };
}

/** Real I/O, separated from the pure lookup above so `modelPricesFor` stays trivially testable
 * with fixture data. Reads the same files `packages/print/src/cli/load-inputs.ts` reads for the
 * real print pipeline — the identical registry/snapshot pair every other real dollar figure in
 * this repo is computed from, not a second, divergent source. */
export async function loadRegistryAndLatestSnapshot(
  dataRoot: string,
): Promise<{ registry: ModelRegistryEntry[]; snapshot: PriceSnapshot }> {
  const registryDir = join(dataRoot, "registry");
  const registry = JSON.parse(
    await readFile(join(registryDir, "models.json"), "utf-8"),
  ) as ModelRegistryEntry[];

  const files = (await readdir(registryDir))
    .filter((f) => f.startsWith("price-snapshot-merged-") && f.endsWith(".json"))
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error(`No merged price snapshot in ${registryDir}.`);
  }
  const snapshot = JSON.parse(
    await readFile(join(registryDir, latest), "utf-8"),
  ) as PriceSnapshot;

  return { registry, snapshot };
}
