import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelRegistryEntry, PriceSnapshot, Print, RunManifest, RunRecord } from "@touchstone/sdk";
import type { ModelInput } from "../compute/index.js";

/** pnpm always runs package scripts with cwd = the package directory. */
export function repoRoot(): string {
  return resolve(process.cwd(), "../..");
}

export function registryDir(): string {
  return resolve(repoRoot(), "data/registry");
}

export function runsDirFor(printId: string): string {
  return resolve(repoRoot(), "data/runs", printId);
}

export function printsDir(): string {
  return resolve(repoRoot(), "data/prints");
}

export async function loadRegistry(): Promise<ModelRegistryEntry[]> {
  return JSON.parse(await readFile(join(registryDir(), "models.json"), "utf-8"));
}

/** Loads a snapshot by its exact filename, so a print pins the snapshot it actually used. */
export async function loadPriceSnapshot(fileName: string): Promise<PriceSnapshot> {
  return JSON.parse(await readFile(join(registryDir(), fileName), "utf-8"));
}

export async function latestPriceSnapshotFile(
  source: "openrouter" | "litellm" | "merged" = "merged",
): Promise<string> {
  const files = (await readdir(registryDir()))
    .filter((f) => f.startsWith(`price-snapshot-${source}-`) && f.endsWith(".json"))
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error(
      `No ${source} price snapshot in ${registryDir()}. Run "pnpm --filter @touchstone/prices run fetch:prices" first.`,
    );
  }
  return latest;
}

/**
 * Scans the directory for candidate run records. The one legitimate use of this: gathering
 * inputs for a print that doesn't exist yet (cli/publish.ts, cli/publish-unattended.ts), before
 * there's a manifest to declare what belongs to it. Every post-publish reader (verify, the MCP
 * server's data sources) must use loadDeclaredRunRecords below instead — see its own doc comment
 * for why a directory listing is not a safe stand-in for the declared list.
 */
export async function loadRunRecords(printId: string): Promise<RunRecord[]> {
  const dir = runsDirFor(printId);
  const files = (
    await readdir(dir).catch(() => {
      throw new Error(`No run records directory at ${dir}.`);
    })
  ).filter((f) => f.endsWith(".json") && !f.endsWith(".raw.json") && f !== "reconciliation.json");

  return Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf-8")) as RunRecord),
  );
}

export async function loadRunManifest(printId: string): Promise<RunManifest> {
  const dir = runsDirFor(printId);
  const path = join(dir, "index.json");
  return JSON.parse(
    await readFile(path, "utf-8").catch(() => {
      throw new Error(
        `No run manifest at ${path}. Every print published after the manifest system shipped ` +
          `has one; older prints need backfill-run-manifest run once — see cli/backfill-run-manifest.ts.`,
      );
    }),
  ) as RunManifest;
}

/**
 * Loads run records by the print's own declared manifest (data/runs/<print_id>/index.json), not
 * by listing the directory — see writeRunManifest's doc comment (publication.ts) for why a
 * directory listing is not a safe stand-in: a same-print_id retry writes into the same
 * directory as an earlier failed attempt's leftovers, and only the manifest states which files
 * actually went into the print. A declared file that's missing on disk is a real integrity
 * problem and throws, rather than silently treating the record as absent.
 */
export async function loadDeclaredRunRecords(printId: string): Promise<RunRecord[]> {
  const dir = runsDirFor(printId);
  const manifest = await loadRunManifest(printId);
  return Promise.all(
    manifest.run_records.map(async (f) => {
      const path = join(dir, f);
      const text = await readFile(path, "utf-8").catch(() => {
        throw new Error(`Manifest for ${printId} declares "${f}", but ${path} does not exist.`);
      });
      return JSON.parse(text) as RunRecord;
    }),
  );
}

export async function loadPrint(path: string): Promise<Print> {
  return JSON.parse(await readFile(path, "utf-8")) as Print;
}

/**
 * Joins run records to their registry entry and the price snapshot's price for that model.
 * A model with runs but no price in the snapshot is reported rather than silently priced at
 * zero — a missing price must never look like free inference.
 */
export function buildModelInputs(
  registry: ModelRegistryEntry[],
  snapshot: PriceSnapshot,
  records: RunRecord[],
): { models: ModelInput[]; unpriced: string[] } {
  const priceByModelId = new Map([...snapshot.entries].map((e) => [e.model_id, e]));
  const recordsByModelId = new Map<string, RunRecord[]>();
  for (const record of records) {
    const list = recordsByModelId.get(record.model_id) ?? [];
    list.push(record);
    recordsByModelId.set(record.model_id, list);
  }

  const models: ModelInput[] = [];
  const unpriced: string[] = [];

  for (const entry of registry) {
    const modelRecords = recordsByModelId.get(entry.id);
    if (!modelRecords || modelRecords.length === 0) {
      continue; // no runs for this model in this print
    }
    const price = priceByModelId.get(entry.id);
    if (!price) {
      unpriced.push(entry.id);
      continue;
    }
    models.push({
      model_id: entry.id,
      price: {
        price_in_usd_per_1m: price.price_in_usd_per_1m,
        price_out_usd_per_1m: price.price_out_usd_per_1m,
      },
      records: modelRecords,
    });
  }

  return { models, unpriced };
}
