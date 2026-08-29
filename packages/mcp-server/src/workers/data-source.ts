import type { KVNamespace } from "@cloudflare/workers-types";
import type { PriceSnapshot, Print, RunRecord } from "@touchstone/sdk";
import type { PrintDataSource } from "../print-data-source.js";
import { GITHUB_API_BASE, GITHUB_RAW_BASE } from "./env.js";
import { cached, type CacheOutcome } from "./kv-cache.js";

const NOT_PUBLISHED_MESSAGE =
  "No print has been published yet — data/prints/ has no latest.json. Publish one with " +
  "`pnpm --filter @touchstone/print run publish-print` first.";

// Prints publish once a day — freshness beyond a few minutes buys nothing, and a short TTL is
// what keeps get_index (and every other tool) from ever failing a call over GitHub being briefly
// slow or rate-limited. Run records and price snapshots are immutable once a print references
// them (the append-only guard — see docs/methodology.md's Revision policy), so they get a much
// longer TTL: there is no staleness to protect against, only repeat-fetch cost.
const PRINT_TTL_SECONDS = 300;
const IMMUTABLE_TTL_SECONDS = 3600;

interface GitHubContentsEntry {
  name: string;
  type: "file" | "dir";
  download_url: string | null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) {
    throw new Error(`GitHub fetch failed for ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/** Every real run record (excludes `.raw.json` provider-response dumps and
 * `reconciliation.json`) for one print, fetched in parallel — matches
 * `@touchstone/print`'s `loadRunRecords` filter exactly. One directory listing (GitHub's Contents
 * API, unauthenticated, no rate-limit concern since the *result* is what's cached, not this call
 * — see IMMUTABLE_TTL_SECONDS above) plus one fetch per file, comfortably inside a paid Workers
 * plan's per-invocation subrequest limit for a basket this size. */
async function fetchRunRecords(printId: string): Promise<RunRecord[]> {
  const listingRes = await fetch(
    `${GITHUB_API_BASE}/contents/data/runs/${encodeURIComponent(printId)}`,
    { headers: { accept: "application/vnd.github+json" } },
  );
  // A 404 means the print genuinely has no run directory — legitimately empty, worth caching.
  // Any other failure (rate limit, GitHub 5xx, network error) is NOT the same thing and must not
  // be swallowed into an empty result: that would let a transient fetch failure get cached for a
  // full IMMUTABLE_TTL_SECONDS as if it were real, permanent "no run records" data — masking the
  // real error behind a wrong business-logic answer for an hour, on a paid tool call.
  if (listingRes.status === 404) return [];
  if (!listingRes.ok) {
    throw new Error(
      `GitHub fetch failed for run records listing (${printId}): ${listingRes.status} ${listingRes.statusText}`,
    );
  }
  const entries = (await listingRes.json()) as GitHubContentsEntry[];

  const files = entries.filter(
    (e) =>
      e.type === "file" &&
      e.name.endsWith(".json") &&
      !e.name.endsWith(".raw.json") &&
      e.name !== "reconciliation.json" &&
      e.download_url,
  );

  return Promise.all(files.map((f) => fetchJson<RunRecord>(f.download_url!)));
}

/**
 * The Cloudflare Workers implementation of `PrintDataSource` (`../print-data-source.js`) — reads
 * `data/` from this repo's own public GitHub content instead of the local filesystem, fronted by
 * a KV cache (`../workers/kv-cache.js`). Every tool in `../tools/` is unchanged: this is the only
 * new code the Workers deployment needed for data access.
 */
export function githubDataSource(kv: KVNamespace): PrintDataSource {
  const print = (key: string, path: string, ttl: number) =>
    cached<Print>(kv, key, ttl, () => fetchJson<Print>(`${GITHUB_RAW_BASE}/${path}`));

  return {
    async loadLatestPrint() {
      const { value, cached: hit, fetchedAt } = await print(
        "print:latest",
        "data/prints/latest.json",
        PRINT_TTL_SECONDS,
      ).catch(() => {
        throw new Error(NOT_PUBLISHED_MESSAGE);
      });
      return { print: value, cached: hit, fetchedAt };
    },

    async loadPrintByDate(date) {
      const { value } = await print(
        `print:${date}`,
        `data/prints/${encodeURIComponent(date)}.json`,
        // A specific print_id/date's file never changes once it exists (append-only guard), so
        // this can be cached as long as the immutable data below — only "latest" needs the short
        // TTL, since which print *is* latest changes daily.
        IMMUTABLE_TTL_SECONDS,
      );
      return value;
    },

    async listPrintIds() {
      const { value } = await cached<{ print_id: string }[]>(
        kv,
        "print:index",
        PRINT_TTL_SECONDS,
        () => fetchJson(`${GITHUB_RAW_BASE}/data/prints/index.json`),
      );
      return value.map((entry) => entry.print_id);
    },

    async loadPriceSnapshot(ref) {
      const { value } = await cached<PriceSnapshot>(
        kv,
        `price-snapshot:${ref}`,
        IMMUTABLE_TTL_SECONDS,
        () => fetchJson(`${GITHUB_RAW_BASE}/data/registry/${encodeURIComponent(ref)}`),
      );
      return value;
    },

    async loadRunRecords(printId) {
      // No blanket catch-to-empty here, deliberately: `cached()` only reaches KV.put on a
      // successful fetch, so letting a real failure propagate (rather than reporting a false
      // "no run records for this class") never poisons the cache — it just fails this one call
      // honestly, and a retry tries again.
      const outcome: CacheOutcome<RunRecord[]> = await cached(
        kv,
        `run-records:${printId}`,
        IMMUTABLE_TTL_SECONDS,
        () => fetchRunRecords(printId),
      );
      return outcome.value;
    },
  };
}
