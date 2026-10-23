import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CR_PUBLIC_DIR, PRIVATE_DIR } from "../paths.js";
import { DataDesk, DataDeskError } from "./desk.js";
import { FixtureBackend } from "./fixtures/backend.js";
import { FIXTURE_AS_OF } from "./fixtures/world.js";
import { RateGovernor, RateLimited } from "./governor.js";
import { Num, type Json } from "./json-decimal.js";
import { catalog, queryId } from "./queries.js";
import { SnapshotCorrupt, SnapshotStore, defaultStoreOptions, sha256Hex } from "./snapshots.js";
import type { BackendResponse, DataBackend, Query } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(
  opts: {
    backend?: DataBackend;
    governor?: RateGovernor;
    log?: (l: string) => void;
    backendName?: "fixtures" | "live";
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "cr-desk-"));
  dirs.push(root);
  const backend = opts.backend ?? new FixtureBackend();
  const store = new SnapshotStore({
    privateRoot: join(root, "private"),
    manifestDir: join(root, "manifests"),
    backend: backend.name,
  });
  const governor =
    opts.governor ??
    new RateGovernor({
      overrides: { "data-api": { minIntervalMs: 0 }, "token-unlocks": { minIntervalMs: 0 } },
    });
  const desk = new DataDesk({
    backend,
    store,
    governor,
    now: () => new Date("2026-10-20T12:00:00Z"),
    ...(opts.log ? { log: opts.log } : {}),
  });
  return { root, backend, store, desk, governor };
}
const W = { window: FIXTURE_AS_OF };
const ok = (obj: unknown): BackendResponse => ({
  status: 200,
  body: new TextEncoder().encode(JSON.stringify(obj)),
  headers: {},
});
const fake = (
  name: "fixtures" | "live",
  respond: (q: Query) => BackendResponse | Promise<BackendResponse>,
): DataBackend & { calls: Query[] } => {
  const calls: Query[] = [];
  return {
    name,
    calls,
    get: async (q) => (calls.push(q), respond(q)),
    specVersions: async () => ({ "data-api": "t-1", "token-unlocks": "t-2" }),
  };
};

describe("one pull per query per window", () => {
  it("fetches once, then serves the stored snapshot without asking again", async () => {
    const { desk, backend } = setup();
    const a = await desk.pull(catalog.perpVenues(), W);
    const b = await desk.pull(catalog.perpVenues(), W);
    expect((backend as FixtureBackend).requests).toHaveLength(1);
    expect(a.fromStore).toBe(false);
    expect(b.fromStore).toBe(true);
    expect(b.bodySha256).toBe(a.bodySha256);
    expect(b.text).toBe(a.text);
  });

  it("pulls again for a new window, and for a different tag within the same window", async () => {
    const { desk, backend } = setup();
    await desk.pull(catalog.perpVenues(), W);
    await desk.pull(catalog.perpVenues(), { window: "2026-10-21" });
    await desk.pull(catalog.perpVenues(), { ...W, tag: "before-session-1" });
    expect((backend as FixtureBackend).requests).toHaveLength(3);
  });

  it("makes one request when the same pull is asked for several times at once", async () => {
    const { desk, backend } = setup();
    const snaps = await Promise.all([1, 2, 3, 4].map(() => desk.pull(catalog.perpVenues(), W)));
    expect((backend as FixtureBackend).requests).toHaveLength(1);
    expect(new Set(snaps.map((s) => s.bodySha256)).size).toBe(1);
  });

  it("keeps different queries apart", async () => {
    const { desk, backend } = setup();
    await desk.pull(catalog.perpVenues(), W);
    await desk.pull(catalog.lendingProtocols(), W);
    expect((backend as FixtureBackend).requests).toHaveLength(2);
  });
});

describe("pacing groups (D122)", () => {
  it("paces a pull under the query's own group by default, and under one chosen group when the caller says so, so two routes to the provider can share one pace", async () => {
    const own = new RateGovernor({ overrides: { "data-api": { minIntervalMs: 0 } } });
    await setup({ governor: own }).desk.pull(catalog.perpVenues(), W);
    expect(own.report().map((r) => r.group)).toEqual(["data-api"]);

    const shared = new RateGovernor({ overrides: { mcp: { minIntervalMs: 0 } } });
    const root = mkdtempSync(join(tmpdir(), "cr-desk-"));
    dirs.push(root);
    const backend = new FixtureBackend();
    const desk = new DataDesk({
      backend,
      store: new SnapshotStore({
        privateRoot: join(root, "p"),
        manifestDir: join(root, "m"),
        backend: backend.name,
      }),
      governor: shared,
      groupFor: () => "mcp",
    });
    await desk.pull(catalog.perpVenues(), W);
    expect(shared.report().map((r) => r.group)).toEqual(["mcp"]);
  });
});

describe("the snapshot is what Blockworks sent, exactly", () => {
  it("stores the response bytes and their sha256, and parses the numbers as text", async () => {
    const raw = '{"error":null,"data":[{"v":0.1000000000000000055511151231257827}]}';
    const be = fake("live", () => ({
      status: 200,
      body: new TextEncoder().encode(raw),
      headers: { "x-request-id": "r1" },
    }));
    const { desk, root } = setup({ backend: be });
    const s = await desk.pull(catalog.perpVenues(), W);
    expect(s.text).toBe(raw);
    expect(s.bodySha256).toBe(sha256Hex(new TextEncoder().encode(raw)));
    const row = ((s.json as { data: { [k: string]: Json }[] }).data[0] as { v: Num }).v;
    expect(row.text).toBe("0.1000000000000000055511151231257827");
    const body = readFileSync(
      join(root, "private", W.window, "daily", `${queryId(catalog.perpVenues())}.body`),
      "utf-8",
    );
    expect(body).toBe(raw);
  });

  it("detects a stored snapshot that has been changed, and refuses to carry on with it or refetch over it", async () => {
    const { desk, root, backend } = setup();
    const q = catalog.perpVenues();
    await desk.pull(q, W);
    writeFileSync(
      join(root, "private", W.window, "daily", `${queryId(q)}.body`),
      '{"error":null,"data":[]}',
    );
    await expect(desk.pull(q, W)).rejects.toBeInstanceOf(SnapshotCorrupt);
    expect((backend as FixtureBackend).requests).toHaveLength(1);
  });

  it("will not read a snapshot from the wrong backend's store", async () => {
    const live = setup({ backend: fake("live", () => ok({ error: null, data: [] })) });
    await live.desk.pull(catalog.perpVenues(), W);
    const wrong = new SnapshotStore({
      privateRoot: join(live.root, "private"),
      manifestDir: join(live.root, "manifests"),
      backend: "fixtures",
    });
    expect(() => wrong.read(W.window, "daily", queryId(catalog.perpVenues()))).toThrow(
      /fetched by the live backend/,
    );
  });
});

describe("the committed manifest holds hashes only", () => {
  it("lists each snapshot by query hash and body hash, sorted, without duplicating a repeated pull", async () => {
    const { desk, store } = setup();
    await desk.pull(catalog.lendingProtocols(), W);
    await desk.pull(catalog.perpVenues(), W);
    await desk.pull(catalog.perpVenues(), W);
    const m = store.manifest(W.window)!;
    expect(m.window).toBe(W.window);
    expect(m.entries).toHaveLength(2);
    expect(m.entries.map((e) => e.queryId)).toEqual(
      [queryId(catalog.lendingProtocols()), queryId(catalog.perpVenues())].sort(),
    );
    for (const e of m.entries) {
      expect(Object.keys(e).sort()).toEqual([
        "backend",
        "bodySha256",
        "bytes",
        "fetchedAt",
        "httpStatus",
        "queryId",
        "tag",
      ]);
      expect(e.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("contains no query text, no series name and nothing from a response", async () => {
    const { desk, root } = setup();
    await desk.pull(
      catalog.perpVolume(["fixture-perp-a", "fixture-perp-b"], "2026-09-01", "2026-10-01"),
      W,
    );
    await desk.pull(catalog.perpVenues(), W);
    const text = readFileSync(join(root, "manifests", `${W.window}.json`), "utf-8");
    for (const leak of [
      "fixture-",
      "series",
      "start=",
      "volumeUSD",
      "perp-dex",
      "/query",
      "Fixture Perp",
      "point_schema",
      "selections",
    ])
      expect(text, leak).not.toContain(leak);
  });

  it("notes the APIs' spec versions once per window", async () => {
    const { desk, store, backend } = setup({
      backend: fake("live", () => ok({ error: null, data: [] })),
    });
    await desk.recordSpecVersions(W.window);
    await desk.recordSpecVersions(W.window);
    expect(store.manifest(W.window)?.specVersions).toEqual({
      "data-api": "t-1",
      "token-unlocks": "t-2",
    });
    expect((backend as ReturnType<typeof fake>).calls).toHaveLength(0);
  });

  it("puts fixture manifests in the private tree and live manifests in the committed one", () => {
    const f = defaultStoreOptions("fixtures");
    const l = defaultStoreOptions("live");
    expect(f.privateRoot.startsWith(PRIVATE_DIR)).toBe(true);
    expect(f.manifestDir.startsWith(PRIVATE_DIR)).toBe(true); // synthetic manifests can never be committed
    expect(l.privateRoot.startsWith(PRIVATE_DIR)).toBe(true);
    expect(l.manifestDir).toBe(join(CR_PUBLIC_DIR, "manifests"));
  });
});

describe("a pull that fails is never stored", () => {
  const empty = (s: ReturnType<typeof setup>) =>
    readdirSync(s.root)
      .filter((n) => n !== "manifests")
      .flatMap((n) => readdirSync(join(s.root, n))).length;

  it("rejects 401 and 403 with a message that says which, and stores nothing", async () => {
    for (const [status, text] of [
      [401, /401.*no key/],
      [403, /403.*invalid or lacks permission/],
    ] as const) {
      const s = setup({
        backend: fake("live", () => ({
          status,
          body: new TextEncoder().encode(JSON.stringify({ error: "Forbidden", data: null })),
          headers: {},
        })),
      });
      await expect(s.desk.pull(catalog.perpVenues(), W)).rejects.toThrow(text);
      expect(empty(s)).toBe(0);
    }
  });

  it("rejects another status, quoting Blockworks' short message, and stores nothing", async () => {
    const s = setup({
      backend: fake("live", () => ({
        status: 500,
        body: new TextEncoder().encode(JSON.stringify({ error: "model exploded", data: null })),
        headers: {},
      })),
    });
    await expect(s.desk.pull(catalog.perpVenues(), W)).rejects.toMatchObject({
      name: "DataDeskError",
      status: 500,
      message: "Blockworks answered 500: model exploded",
    });
    expect(empty(s)).toBe(0);
  });

  it("rejects a 200 whose error field is set, and a 200 that is not JSON", async () => {
    const a = setup({ backend: fake("live", () => ok({ error: "no such model", data: null })) });
    await expect(a.desk.pull(catalog.perpVenues(), W)).rejects.toThrow(/error field is set/);
    expect(empty(a)).toBe(0);
    const b = setup({
      backend: fake("live", () => ({
        status: 200,
        body: new TextEncoder().encode("<html>maintenance</html>"),
        headers: {},
      })),
    });
    await expect(b.desk.pull(catalog.perpVenues(), W)).rejects.toThrow(/not JSON/);
    expect(empty(b)).toBe(0);
  });

  it("stores a legitimately empty answer, which is what Blockworks said", async () => {
    const s = setup({ backend: fake("live", () => ok({ error: null, data: null })) });
    const snap = await s.desk.pull(catalog.perpVenues(), W);
    expect((snap.json as { data: Json }).data).toBeNull();
    expect(s.store.manifest(W.window)?.entries).toHaveLength(1);
  });

  it("goes through the governor: a rate-limited backend is retried, then stopped, and a later attempt starts clean", async () => {
    let t = 0;
    const governor = new RateGovernor({
      now: () => t,
      sleep: async (ms) => void (t += ms),
      overrides: { "data-api": { minIntervalMs: 0, maxRetries: 2 } },
    });
    const be = fake("live", () => ({
      status: 429,
      body: new TextEncoder().encode(JSON.stringify({ error: "slow down", data: null })),
      headers: { "retry-after": "5" },
    }));
    const s = setup({ backend: be, governor });
    await expect(s.desk.pull(catalog.perpVenues(), W)).rejects.toBeInstanceOf(RateLimited);
    expect(be.calls).toHaveLength(3);
    expect(governor.events.filter((e) => e.kind === "backoff")).toHaveLength(2);
    expect(empty(s)).toBe(0);
    await expect(s.desk.pull(catalog.perpVenues(), W)).rejects.toBeInstanceOf(RateLimited); // not cached as a failure: it asks again
    expect(be.calls).toHaveLength(6);
  });

  it("spaces two different pulls by the governor's interval", async () => {
    let t = 1_000_000;
    const governor = new RateGovernor({ now: () => t, sleep: async (ms) => void (t += ms) });
    const s = setup({ governor });
    await s.desk.pull(catalog.perpVenues(), W);
    await s.desk.pull(catalog.lendingProtocols(), W);
    expect(governor.events.filter((e) => e.kind === "spacing")).toHaveLength(1);
    expect(governor.report()).toEqual([
      expect.objectContaining({ group: "data-api", requestsToday: 2 }),
    ]);
  });

  it("is a DataDeskError a caller can tell from a programming error", async () => {
    const s = setup({
      backend: fake("live", () => ({
        status: 404,
        body: new TextEncoder().encode("{}"),
        headers: {},
      })),
    });
    await expect(s.desk.pull(catalog.perpVenues(), W)).rejects.toBeInstanceOf(DataDeskError);
  });
});

describe("what the desk accepts and says", () => {
  it("rejects a bad window, a bad tag and a path the catalog never builds", () => {
    const { desk } = setup();
    expect(() => desk.pull(catalog.perpVenues(), { window: "2026-13-45" })).toThrow(TypeError);
    expect(() => desk.pull(catalog.perpVenues(), { window: "../../etc" })).toThrow(TypeError);
    expect(() => desk.pull(catalog.perpVenues(), { ...W, tag: "../up" })).toThrow(TypeError);
    expect(() => desk.pull(catalog.perpVenues(), { ...W, tag: "Has Caps" })).toThrow(TypeError);
    expect(() => desk.pull({ api: "data", path: "/admin", params: {} }, W)).toThrow(TypeError);
  });

  it("logs hashes and sizes only: never a query's text, a series name or any of the response", async () => {
    const lines: string[] = [];
    const { desk } = setup({ log: (l) => lines.push(l) });
    const s = await desk.pull(
      catalog.perpVolume(["fixture-perp-a"], "2026-09-01", "2026-09-05"),
      W,
    );
    await desk.pull(catalog.perpVenues(), W);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^pulled [0-9a-f]{12} \d+B sha256 [0-9a-f]{12} \(2026-10-20\/daily\)$/,
    );
    const all = lines.join("\n");
    for (const leak of ["fixture-", "series", "volumeUSD", "/query", s.text.slice(40, 70)])
      expect(all, leak).not.toContain(leak);
  });
});
