import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KVNamespace } from "@cloudflare/workers-types";
import type { RunManifest, RunRecord } from "@touchstone/sdk";
import { githubDataSource } from "./data-source.js";

/** Minimal in-memory fake — only the two methods `cached()` (kv-cache.ts) actually calls.
 * `puts` records every `put()` call's TTL, so a test can assert on it directly rather than trust
 * a passing test to mean the right value was used. */
function fakeKv(): { kv: KVNamespace; puts: { key: string; expirationTtl?: number }[] } {
  const store = new Map<string, string>();
  const puts: { key: string; expirationTtl?: number }[] = [];
  const kv = {
    async get(key: string) {
      const raw = store.get(key);
      return raw ? JSON.parse(raw) : null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, value);
      puts.push({ key, expirationTtl: options?.expirationTtl });
    },
  } as unknown as KVNamespace;
  return { kv, puts };
}

function runRecord(id: string): RunRecord {
  return {
    run_id: id,
    model_id: "deepseek-v3.2",
    task_class: "T1",
    instance_id: "T1-01",
    seed: 1,
    attempt: 1,
    usage: { input: 100, output: 10, cached_input: 0, reasoning: 0 },
    latency_ms: 500,
    gate_passed: true,
    raw_response_ref: `${id}.raw.json`,
  };
}

describe("githubDataSource.loadRunRecords", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the declared manifest, then only the files it declares — from raw.githubusercontent.com, never api.github.com", async () => {
    const manifest: RunManifest = {
      print_id: "2026-08-31",
      basket_version: "SIU-2026a",
      methodology_version: "v0-draft",
      run_records: ["a.json", "b.json"],
    };
    const recordA = runRecord("a");
    const recordB = runRecord("b");
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/data/runs/2026-08-31/index.json")) {
        return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
      }
      if (url.endsWith("/data/runs/2026-08-31/a.json")) {
        return Promise.resolve(new Response(JSON.stringify(recordA), { status: 200 }));
      }
      if (url.endsWith("/data/runs/2026-08-31/b.json")) {
        return Promise.resolve(new Response(JSON.stringify(recordB), { status: 200 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const records = await githubDataSource(fakeKv().kv).loadRunRecords("2026-08-31");

    expect(records).toEqual([recordA, recordB]);
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toContain("raw.githubusercontent.com");
      expect(url).not.toContain("api.github.com");
    }
  });

  it("never has more than 5 file fetches in flight at once, even for a large manifest", async () => {
    // Found live: 94 declared run records fetched via a flat Promise.all failed every call with
    // "Too many subrequests by single Worker invocation" — Cloudflare's 6-simultaneous-connection
    // ceiling, not a total-count limit. This reproduces that shape at a size the test can assert
    // on directly, tracking peak concurrency rather than trusting a passing test to mean bounded.
    const fileNames = Array.from({ length: 20 }, (_, i) => `${i}.json`);
    const manifest: RunManifest = {
      print_id: "2026-08-31",
      basket_version: "SIU-2026a",
      methodology_version: "v0-draft",
      run_records: fileNames,
    };
    let inFlight = 0;
    let peak = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/index.json")) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const fileName = url.split("/").pop()!;
      return new Response(JSON.stringify(runRecord(fileName)), { status: 200 });
    });

    const records = await githubDataSource(fakeKv().kv).loadRunRecords("2026-08-31");

    expect(records).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it("throws a clear, honest error when a print has no manifest at all, rather than silently returning empty", async () => {
    fetchMock.mockResolvedValue(new Response("Not Found", { status: 404 }));

    await expect(githubDataSource(fakeKv().kv).loadRunRecords("2026-08-18")).rejects.toThrow(
      /no run-record manifest/i,
    );
  });

  it("propagates a transient fetch failure honestly rather than caching it as empty", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(githubDataSource(fakeKv().kv).loadRunRecords("2026-08-31")).rejects.toThrow(/429/);
  });

  it("caches run records for at least a week — this data can never go stale, so a short TTL only buys back-to-back cold fetches", async () => {
    // Found live: a real get_quote call paid ~8s re-fetching a 9-constituent print's full
    // run-record set on a cache miss — 86% of a measured 10.4s call — because the previous TTL
    // (3600s) was shorter than a single day of light traffic. Regression test for the fix: a
    // caller some real distance in the future must still get a cache hit, not force the ~8s cold
    // path again for data that hasn't changed and structurally cannot change (the append-only
    // guard — docs/methodology.md's Revision policy).
    const manifest: RunManifest = {
      print_id: "2026-08-31",
      basket_version: "SIU-2026a",
      methodology_version: "v0-draft",
      run_records: ["a.json"],
    };
    fetchMock.mockImplementation((url: string) =>
      url.endsWith("/index.json")
        ? Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }))
        : Promise.resolve(new Response(JSON.stringify(runRecord("a")), { status: 200 })),
    );

    const { kv, puts } = fakeKv();
    await githubDataSource(kv).loadRunRecords("2026-08-31");

    const runRecordsPut = puts.find((p) => p.key === "run-records:2026-08-31");
    expect(runRecordsPut?.expirationTtl).toBeGreaterThanOrEqual(60 * 60 * 24 * 7);
  });
});
