import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataDesk } from "../data-desk/desk.js";
import { FixtureBackend } from "../data-desk/fixtures/backend.js";
import { RateGovernor } from "../data-desk/governor.js";
import { catalog, queryId } from "../data-desk/queries.js";
import { assertWindowAndTag } from "../data-desk/snapshots.js";
import { standInSeat } from "../runner/stand-in-models.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance } from "../tasks/instances.js";
import { solveSM } from "../tasks/solve.js";
import { FakeMcp, LIVE_LAG } from "./fake-mcp.js";
import { McpSessionsAborted } from "./incident-guard.js";
import { keyTagFor, pullSessionKey } from "./key-snapshot.js";
import { referenceFor } from "./relayed.js";
import { runMcpAnswer } from "./session.js";
import { standInMessagesApi } from "./stand-in-agent.js";
import { toMcpInstance } from "./variants.js";

let f: FixtureDay;
let tmp: string;
beforeAll(async () => {
  f = await fixtureDay(undefined, {}, LIVE_LAG);
});
afterAll(() => f.cleanup());
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cr-key-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const W = () => f.day.window;
const fast = { minIntervalMs: 0, baseBackoffMs: 1, maxBackoffMs: 1, maxRetries: 1 };
const deskOver = (backend: FixtureBackend) =>
  new DataDesk({
    backend,
    store: f.store,
    governor: new RateGovernor({ overrides: { "data-api": fast } }),
  });
/** the day's own world: the stablecoin series publish a day late, as when the daily snapshot was pulled */
const dailyWorld = () => new FixtureBackend({ lagByModel: LIVE_LAG });
/** a later pull: the provider has published the day (nothing is late) */
const laterWorld = () => new FixtureBackend();

const SEED = "7".repeat(64);
const AT = new Date("2026-10-23T10:00:00Z");
const drawn = () =>
  drawInstances(f.day, SEED, 1)
    .map((i) => toMcpInstance(i, f.day)?.instance)
    .filter((i): i is Instance => i !== undefined);
const instanceOf = (task: Instance["task"]) => drawn().find((i) => i.task === task) as Instance;
const smOf = (dimension: "chain" | "issuer"): Instance => {
  const base = instanceOf("CR-SM") as Extract<Instance, { task: "CR-SM" }>;
  return {
    ...base,
    params: { dimension },
    reference: solveSM(f.day, dimension) as never,
  } as Instance;
};
let n = 0;
const key = (backend: FixtureBackend, instance: Instance) =>
  pullSessionKey({
    desk: deskOver(backend),
    store: f.store,
    instance,
    window: W(),
    tag: keyTagFor(instance, `m${++n}`, AT),
  });

describe("a session's answer key, pulled at the session's own time (D117)", () => {
  it("has a tag the snapshot store accepts, and one per session", () => {
    const i = instanceOf("CR-PL");
    const a = keyTagFor(i, "claude-haiku-4-5", AT);
    const b = keyTagFor(i, "claude-sonnet-5", AT);
    expect(() => assertWindowAndTag(W(), a)).not.toThrow();
    expect(a).not.toBe(b);
    expect(a).toBe(a.toLowerCase());
    // a resumed attempt gets a tag of its own, so it can never find the key an interrupted one pulled (2026-10-23: a session graded against a key 54 minutes old)
    expect(keyTagFor(i, "claude-haiku-4-5", new Date(AT.getTime() + 3_255_000))).not.toBe(a);
  });

  it("pulls only what the question needs: one request for a protocol's quarter, not the day's whole plan", async () => {
    const backend = laterWorld();
    const k = await key(backend, instanceOf("CR-PL"));
    expect(backend.requests).toHaveLength(1);
    expect(k.requests).toBe(1);
    expect(f.store.manifest(W())?.entries.some((e) => e.tag === k.tag)).toBe(true);
  });

  it("gives, from the same data, the same key as the day's snapshot, for every question MCP mode asks", async () => {
    for (const instance of [
      instanceOf("CR-VS"),
      instanceOf("CR-PL"),
      smOf("chain"),
      smOf("issuer"),
    ]) {
      const k = await key(dailyWorld(), instance);
      expect(referenceFor(instance, k.day), instance.id).toEqual(instance.reference);
      expect(k.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("gives a different key when the provider has published more since the day's snapshot (the 2026-10-20 case)", async () => {
    const instance = smOf("chain");
    const later = await key(laterWorld(), instance);
    expect([...later.day.stablecoins.chain.values()].every((s) => s.last.day === W())).toBe(true);
    expect([...f.day.stablecoins.chain.values()].every((s) => s.last.day !== W())).toBe(true);
    expect(referenceFor(instance, later.day)).not.toEqual(instance.reference);
  });

  it("times the pull: the key's time is the time its last request answered", async () => {
    const k = await key(laterWorld(), instanceOf("CR-PL"));
    expect(Date.parse(k.pulledAt)).not.toBeNaN();
    expect(Date.now() - Date.parse(k.pulledAt)).toBeLessThan(60_000);
  });
});

describe("a session graded against its own key", () => {
  const seat = standInSeat("solver", { id: "stand-in-researcher", provider: "anthropic" });
  const ledger = () =>
    new SpendLedger({
      store: new MemoryLedgerStore(),
      policy: {
        dailyCapUsd: "9",
        providers: { anthropic: { budgetUsd: "100", since: "2026-01-01T00:00:00Z" } },
      },
    });
  const play = async (
    instance: Instance,
    keyFor?: Parameters<typeof runMcpAnswer>[0]["keyFor"],
  ) => {
    const api = standInMessagesApi("researcher", instance, f.day);
    // the MCP serves the LATER world: the provider has published since the day's snapshot
    const mcp = new FakeMcp({ backend: laterWorld(), today: W() });
    const out = await runMcpAnswer({
      api,
      mcp,
      ledger: ledger(),
      seat,
      instance,
      window: W(),
      daySha256: "d".repeat(64),
      sessionsDir: join(tmp, "sessions"),
      ...(keyFor !== undefined ? { keyFor } : {}),
    });
    return { ...out, api };
  };

  it("passes a correct session against a key taken at its own time, and records when, and how long after, the key was pulled", async () => {
    const instance = smOf("chain");
    const { record } = await play(instance, (i, s) =>
      pullSessionKey({
        desk: deskOver(laterWorld()),
        store: f.store,
        instance: i,
        window: W(),
        tag: keyTagFor(i, s.modelId, AT),
      }),
    );
    expect(record.passed).toBe(true);
    expect(record.mcp?.snapshot_check).toBe("same");
    const k = record.mcp?.key;
    expect(k?.tag).toBe(keyTagFor(instance, seat.modelId, AT));
    expect(k?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(k?.requests).toBeGreaterThan(0);
    expect(Date.parse(k?.session_started_at ?? "")).toBeGreaterThanOrEqual(
      Date.parse(k?.pulled_at ?? ""),
    );
    expect(k?.gap_ms).toBe(Date.parse(k?.session_ended_at ?? "") - Date.parse(k?.pulled_at ?? ""));
    expect(f.store.manifest(W())?.entries.some((e) => e.tag === k?.tag)).toBe(true);
  });

  it("and the SAME correct session fails against the day's older snapshot, which is why the key is taken at the session's time", async () => {
    const { record } = await play(smOf("chain"));
    expect(record.passed).toBe(false);
    expect(record.mcp?.snapshot_check).toBe("differs");
    expect(record.mcp?.key).toBeUndefined();
  });

  it("a key pull that fails stops the run BEFORE the model is called, so no money is spent on a session that could not be graded", async () => {
    const instance = instanceOf("CR-PL") as Extract<Instance, { task: "CR-PL" }>;
    const q = catalog.lendingFinancials(
      [instance.params.protocolId],
      instance.params.start,
      instance.params.end,
    );
    const broken = new FixtureBackend({ faults: { [queryId(q)]: 503 } });
    const api = standInMessagesApi("researcher", instance, f.day);
    const spendLedger = ledger();
    await expect(
      runMcpAnswer({
        api,
        mcp: new FakeMcp({ backend: laterWorld(), today: W() }),
        ledger: spendLedger,
        seat,
        instance,
        window: W(),
        daySha256: "d".repeat(64),
        sessionsDir: join(tmp, "sessions"),
        keyFor: (i, s) =>
          pullSessionKey({
            desk: deskOver(broken),
            store: f.store,
            instance: i,
            window: W(),
            tag: keyTagFor(i, s.modelId, AT),
          }),
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof McpSessionsAborted && e.incident.kind === "key-pull-failed",
    );
    expect(api.requests).toHaveLength(0);
    expect(Number(spendLedger.report().spentToday)).toBe(0);
  });
});
