import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelRegistryEntry, PriceSnapshot, Print, RunManifest, RunRecord } from "@touchstone/sdk";
import { CARRY_FORWARD_CAP_DAYS, type CarryForwardDay, type ModelInput } from "../compute/index.js";
import { D, type DecimalValue } from "../decimal.js";

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

export function reconciliationsDir(): string {
  return resolve(repoRoot(), "data/reconciliations");
}

/** Deliberately its own top-level directory, sibling to data/prints/ — not a file inside
 * data/prints/ itself, which every consumer that globs that directory (site/src/data.ts,
 * loadCarryForwardHistory below, cli/verify-all.ts's own print listing) expects to contain only
 * real, schema-valid Print objects. Found live, 2026-09-26: a first attempt put this file inside
 * data/prints/ and broke the site's own build (loadAllPrints tried to sort it as a print, crashed
 * on its missing `date` field) — moving it here means no consumer's own exclusion list ever
 * needs to know this file exists. */
export function verifyDataDir(): string {
  return resolve(repoRoot(), "data/verify");
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
 * Loads the blended Dated SIU prints from the last CARRY_FORWARD_CAP_DAYS calendar days before
 * `beforeDate`, for computeIndex's own carry-forward step (see compute/index.ts's
 * CarryForwardDay/findCarryForward). Only ever reads each prior day's own already-published,
 * already-signed `cost_usd` values — never recomputes anything — so a carried-forward figure is
 * always a real number this system already stood behind once, not a fresh estimate.
 *
 * Scoped to the blended print series only (filenames matching exactly "YYYY-MM-DD.json", never
 * the "-frontier"/"-commodity" tier suffixes, "index.json", or "latest.json") — the tier series
 * don't yet have carry-forward; see docs/methodology.md's Aggregation section for why that's a
 * disclosed scope decision, not an oversight. computeIndex enforces the real 3-day cap itself by
 * calendar-day arithmetic against `beforeDate`, so this deliberately casts a slightly wider net
 * (a few extra candidate days) rather than trying to duplicate that arithmetic here — harmless,
 * since anything outside the real window is simply never reached.
 */
export async function loadCarryForwardHistory(
  dir: string,
  beforeDate: string,
): Promise<CarryForwardDay[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) =>
    /^\d{4}-\d{2}-\d{2}\.json$/.test(f),
  );
  const candidateDates = files
    .map((f) => f.slice(0, "YYYY-MM-DD".length))
    .filter((date) => date < beforeDate)
    .sort()
    .reverse()
    .slice(0, CARRY_FORWARD_CAP_DAYS + 2); // a little slack; computeIndex enforces the real cap

  const days: CarryForwardDay[] = [];
  for (const date of candidateDates) {
    const print = await loadPrint(join(dir, `${date}.json`));
    const costs = new Map<string, DecimalValue>();
    for (const row of print.basket_costs) {
      if (row.cost_usd !== undefined) {
        costs.set(row.model_id, new D(row.cost_usd));
      }
    }
    days.push({ date, costs });
  }
  return days;
}

/**
 * Joins run records to their registry entry and the price snapshot's price for that model.
 * A model with runs but no price in the snapshot is reported rather than silently priced at
 * zero — a missing price must never look like free inference.
 *
 * Every registered model is included in the returned `models` array, even one with zero run
 * records — this used to `continue` past those, which meant `computeIndex` never saw them at
 * all and they simply never appeared in a print's `basket_costs`/`exchange_rate_table`, not even
 * as a gap row. That silently violated methodology.md §5's own stated invariant ("a model with
 * any undefined class is excluded from that print's headline reference set, appearing in the
 * exchange-rate table with an explicit excluded_reason rather than a silent gap") for exactly the
 * failure mode most likely to produce zero run records in the first place: a total provider-side
 * outage (an expired key, a billing failure, an API change) rather than a model that ran and
 * failed its quality gate. Confirmed live on the 2026-09-08 print: both Anthropic constituents
 * hit a billing failure on every attempt, produced no run records, and vanished from the print
 * with no disclosure — a 33% Dated SIU drop that read as a market move. `computeClassCost`
 * already has a distinct reason for this case ("no run records for this class", as opposed to
 * "all N instance(s) failed the quality gate") — passing `records: []` through here for a
 * zero-record model is all that's needed for that already-correct downstream logic to run.
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
    const modelRecords = recordsByModelId.get(entry.id) ?? [];
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
        // Found live 2026-09-25, while tracing why an OpenRouter-sourced cached rate never
        // reached a real print: this field was never copied through here at all, for any source
        // — the cached-input pricing fix (29d4be2, 2026-09-13) added it to the schema, the cost
        // formula, and litellm.ts's snapshot sourcing, but never to the one place that actually
        // hands a price to computeClassCost/computeCostOfProduction. Every model with a real,
        // published cached rate (not only the OpenRouter-routed ones this session was checking)
        // has been priced at zero on cached_input in every real print since, contradicting
        // docs/methodology.md's own "priced where a published cached rate exists" claim.
        ...(price.price_cached_in_usd_per_1m != null
          ? { price_cached_in_usd_per_1m: price.price_cached_in_usd_per_1m }
          : {}),
      },
      records: modelRecords,
    });
  }

  return { models, unpriced };
}
