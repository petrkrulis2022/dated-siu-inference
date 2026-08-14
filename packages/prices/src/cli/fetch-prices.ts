import { readFile } from "node:fs/promises";
import type { ModelRegistryEntry } from "@datum/sdk";
import {
  buildPriceSnapshotFromLiteLLM,
  buildPriceSnapshotFromOpenRouter,
} from "../snapshot/build-snapshot.js";
import { writeSnapshot } from "../snapshot/write-snapshot.js";
import { registryDir, registryModelsPath } from "./paths.js";

// flagSubsidised() (snapshot/build-snapshot.ts) is deliberately not wired in here yet.
// It needs a floor in $/1M-tokens, and the only floor input this package can produce is
// $/GPU-hour (floor/gpu-rate-snapshot.ts) — converting one to the other needs measured
// GPU-seconds-per-basket from the harness, which doesn't exist yet. Comparing a raw
// $/GPU-hour rate against a $/1M-token price directly would be comparing the wrong units
// and mislabeling real prices as subsidised. Wire this once the harness/print pipeline
// can supply an actual $/1M-token floor.

const registry = JSON.parse(await readFile(registryModelsPath(), "utf-8")) as ModelRegistryEntry[];
if (registry.length === 0) {
  console.error("data/registry/models.json is empty — run seed:registry first.");
  process.exit(1);
}

const dir = registryDir();
const timestamp = new Date().toISOString();

for (const [label, build] of [
  ["openrouter", buildPriceSnapshotFromOpenRouter] as const,
  ["litellm", buildPriceSnapshotFromLiteLLM] as const,
]) {
  const { snapshot, unmatched } = await build(registry, timestamp, timestamp);
  const path = await writeSnapshot(dir, snapshot);
  console.log(`[${label}] wrote ${snapshot.entries.length} entries -> ${path}`);
  if (unmatched.length > 0) {
    console.log(`[${label}] unmatched (no price found): ${unmatched.join(", ")}`);
  }
}
