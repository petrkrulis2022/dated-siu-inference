import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRegistryEntry, PriceSnapshot } from "@touchstone/sdk";
import { registryDir, registryModelsPath } from "./paths.js";

export async function loadRegistry(): Promise<ModelRegistryEntry[]> {
  return JSON.parse(await readFile(registryModelsPath(), "utf-8")) as ModelRegistryEntry[];
}

export async function loadLatestPriceSnapshot(
  source: "openrouter" | "litellm" = "openrouter",
): Promise<PriceSnapshot> {
  const dir = registryDir();
  const files = (await readdir(dir))
    .filter((f) => f.startsWith(`price-snapshot-${source}-`) && f.endsWith(".json"))
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error(
      `No ${source} price snapshot found in ${dir}. Run "pnpm --filter @touchstone/prices run fetch:prices" first.`,
    );
  }
  return JSON.parse(await readFile(join(dir, latest), "utf-8")) as PriceSnapshot;
}
