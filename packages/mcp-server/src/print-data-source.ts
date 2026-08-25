import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PriceSnapshot, Print, RunRecord } from "@touchstone/sdk";
import { loadPrint, loadPriceSnapshot, loadRunRecords, printsDir } from "@touchstone/print";

const NOT_PUBLISHED_MESSAGE =
  "No print has been published yet — data/prints/ has no latest.json. Publish one with " +
  "`pnpm --filter @touchstone/print run publish-print` first.";

/**
 * What the four tools need to read, factored out of the fs-specific implementation below so the
 * Cloudflare Workers entry point (src/workers/, no filesystem) can supply a KV-cached
 * fetch-against-GitHub-raw-content implementation instead — without duplicating any
 * tool-registration or tool logic. This is the only seam; every tool in ./tools/ is otherwise a
 * pure function over already-loaded data.
 */
export interface PrintDataSource {
  /** Rejects with a caller-facing "no print published yet" message, not a raw fs/fetch error.
   * `cached`/`fetchedAt` let get_index report honestly whether this was a cache hit or a fresh
   * read — the Node/fs implementation has no cache, so it always reports `cached: false`. */
  loadLatestPrint(): Promise<{ print: Print; cached: boolean; fetchedAt: string }>;
  /** May reject plainly (e.g. not found) — callers wrap with a caller-facing message. */
  loadPrintByDate(date: string): Promise<Print>;
  /** Every print id available to search, excluding latest.json/index.json. */
  listPrintIds(): Promise<string[]>;
  loadPriceSnapshot(ref: string): Promise<PriceSnapshot>;
  /** Never rejects — a missing run-records directory is a real, expected state (e.g. a model
   * excluded from a print), matching the fs-based default's own `.catch(() => [])` convention
   * rather than failing the whole tool call over it. */
  loadRunRecords(printId: string): Promise<RunRecord[]>;
}

/** The Node/CLI implementation — reads `data/prints/`/`data/registry/` off the local filesystem
 * via `@touchstone/print`. Used by `cli/serve.ts` (the long-running Express server) and by every
 * test in ./tools/*.test.ts; never used by the Workers build. */
export function defaultDataSource(printsDirPath: string = printsDir()): PrintDataSource {
  return {
    loadLatestPrint: async () => {
      const print = await loadPrint(join(printsDirPath, "latest.json")).catch(() => {
        throw new Error(NOT_PUBLISHED_MESSAGE);
      });
      return { print, cached: false, fetchedAt: new Date().toISOString() };
    },
    loadPrintByDate: (date) => loadPrint(join(printsDirPath, `${date}.json`)),
    listPrintIds: async () => {
      const files = await readdir(printsDirPath).catch(() => [] as string[]);
      return files
        .filter((f) => f !== "latest.json" && f !== "index.json" && f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length));
    },
    loadPriceSnapshot: (ref) => loadPriceSnapshot(ref),
    loadRunRecords: (printId) => loadRunRecords(printId).catch(() => []),
  };
}
