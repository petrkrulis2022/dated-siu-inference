import type { KVNamespace } from "@cloudflare/workers-types";
import type { PriceSnapshot, Print, RunManifest, RunRecord } from "@touchstone/sdk";
import type { PrintDataSource } from "../print-data-source.js";
import { GITHUB_RAW_BASE } from "./env.js";
import { cached, type CacheOutcome } from "./kv-cache.js";

const NOT_PUBLISHED_MESSAGE =
  "No print has been published yet — data/prints/ has no latest.json. Publish one with " +
  "`pnpm --filter @touchstone/print run publish-print` first.";

// Prints publish once a day — freshness beyond a few minutes buys nothing, and a short TTL is
// what keeps get_index (and every other tool) from ever failing a call over GitHub being briefly
// slow or rate-limited. Run records and price snapshots are immutable once a print references
// them (the append-only guard — see docs/methodology.md's Revision policy), so there is no
// staleness risk to protect against at all, only repeat-fetch cost — the TTL exists purely to
// bound KV storage, not to keep this data fresh.
const PRINT_TTL_SECONDS = 300;
// Found live: a get_quote call after this expired (routine — the previous value, 3600s, is
// shorter than a single day) paid ~8s fetching a 9-constituent print's full run-record set
// (fetchRunRecords, concurrency-bounded but still ~130 individual raw.githubusercontent.com
// requests) — 86% of a real measured 10.4s call, dwarfing Circle Gateway's own real network cost
// (~470ms: a 178ms 402 challenge plus a 295ms settlement, measured the same session). Since this
// data can never go stale, 30 days trades a little extra KV storage (cheap) for making that cold
// path something a real caller hits roughly once a month per print rather than routinely within
// a single day of light traffic.
const IMMUTABLE_TTL_SECONDS = 60 * 60 * 24 * 30;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) {
    throw new Error(`GitHub fetch failed for ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

// Cloudflare Workers (and Durable Objects, which this runs inside — TouchstoneMcpAgent) cap
// *simultaneous* outbound connections at 6 per invocation — not a total-count limit, a
// concurrency one. Found live: a basket with 94 run records, fetched via a flat Promise.all,
// failed every call with "Too many subrequests by single Worker invocation" — the manifest fix
// (above) had already removed the GitHub Contents API dependency correctly, this is a second,
// independent limit the same 94-file fetch ran into next. 5 stays comfortably under the
// platform's 6-connection ceiling, leaving headroom for whatever else the isolate has in flight.
const MAX_CONCURRENT_FETCHES = 5;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const MANIFEST_MISSING_MESSAGE = (printId: string) =>
  `No run-record manifest (data/runs/${printId}/index.json) for this print. Every print ` +
  `published after the manifest system shipped (2026-08-30 onward) has one; this print predates ` +
  `it and has never been backfilled.`;

/**
 * Every real run record for one print, read via the declared manifest — the same
 * `data/runs/<print_id>/index.json` `@touchstone/print`'s `loadDeclaredRunRecords` reads from
 * the local filesystem, here read from `raw.githubusercontent.com` instead (a CDN with no
 * meaningful per-caller rate limit, unlike GitHub's Contents API — see the git history for why
 * this replaced an earlier version that listed the directory via that API: Cloudflare Workers'
 * shared egress IP pool exhausted its unauthenticated 60/hour limit routinely, and the fix
 * chosen deliberately was "stop calling that API", not "authenticate to it" — this service holds
 * no credential it doesn't need). One fetch for the manifest, one per declared file, bounded to
 * MAX_CONCURRENT_FETCHES at a time (the platform's own simultaneous-connection ceiling).
 */
async function fetchRunRecords(printId: string): Promise<RunRecord[]> {
  const manifestUrl = `${GITHUB_RAW_BASE}/data/runs/${encodeURIComponent(printId)}/index.json`;
  const manifestRes = await fetch(manifestUrl, { headers: { accept: "application/vnd.github+json" } });
  // A 404 means this print genuinely has no manifest — either it predates the manifest system
  // (see MANIFEST_MISSING_MESSAGE) or it's still mid-publish. Not the same thing as a transient
  // fetch failure (rate limit, GitHub 5xx, network error), which must propagate honestly instead
  // of being swallowed into an empty result and cached as if it were real "no run records" data.
  if (manifestRes.status === 404) {
    throw new Error(MANIFEST_MISSING_MESSAGE(printId));
  }
  if (!manifestRes.ok) {
    throw new Error(
      `GitHub fetch failed for run manifest (${printId}): ${manifestRes.status} ${manifestRes.statusText}`,
    );
  }
  const manifest = (await manifestRes.json()) as RunManifest;

  return mapWithConcurrency(manifest.run_records, MAX_CONCURRENT_FETCHES, (fileName) =>
    fetchJson<RunRecord>(
      `${GITHUB_RAW_BASE}/data/runs/${encodeURIComponent(printId)}/${encodeURIComponent(fileName)}`,
    ),
  );
}

/**
 * The Cloudflare Workers implementation of `PrintDataSource` (`../print-data-source.js`) — reads
 * `data/` from this repo's own public GitHub content instead of the local filesystem, fronted by
 * a KV cache (`../workers/kv-cache.js`). Every tool in `../tools/` is unchanged: this is the only
 * new code the Workers deployment needed for data access. Every fetch here reads
 * `raw.githubusercontent.com`, a CDN — no GitHub REST API call, no credential, anywhere in this
 * file.
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
