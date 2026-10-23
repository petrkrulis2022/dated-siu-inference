import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DailyRequestLimit,
  HourlyRequestLimit,
  RateGovernor,
  RateLimited,
} from "../data-desk/governor.js";
import { DataDesk } from "../data-desk/desk.js";
import { FixtureBackend } from "../data-desk/fixtures/backend.js";
import { runLiveMcpDay, type LiveMcpRunDeps } from "../ops/mcp-live-run.js";
import { MemoryRecordStore, type AnswerRecord } from "../runner/records.js";
import { standInSeat } from "../runner/stand-in-models.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances } from "../tasks/instances.js";
import { SeedBook } from "../tasks/seeds.js";
import { anthropicChat } from "./anthropic-loop.js";
import { FakeMcp, LIVE_LAG } from "./fake-mcp.js";
import {
  AbortOnIncidentStore,
  InfraWatchMcp,
  McpSessionsAborted,
  classifyIncident,
} from "./incident-guard.js";
import { McpLoginRequired, McpTransportFailure } from "./live-mcp.js";
import { buildMcpPrompt } from "./prompts.js";
import { routedStandInApi } from "./stand-in-agent.js";
import { toMcpInstance } from "./variants.js";
import type { McpBackend, McpCallResult } from "./types.js";

const record = (instance: string, model = "m"): AnswerRecord =>
  ({ instance, model, window: "2026-10-20" }) as AnswerRecord;

/** A backend that fails the calls it is told to, the way the live service can. */
class Scripted implements McpBackend {
  readonly name = "fake" as const;
  calls = 0;
  constructor(
    private readonly inner: McpBackend,
    private readonly failOn: (n: number) => Error | McpCallResult | undefined,
  ) {}
  tools() {
    return this.inner.tools();
  }
  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const f = this.failOn(++this.calls);
    if (f instanceof Error) throw f;
    if (f !== undefined) return f;
    return this.inner.call(name, args);
  }
  async close(): Promise<void> {}
}

describe("what counts as a service failure", () => {
  it("names the class of each, and never keeps a message from the server", () => {
    expect(classifyIncident(new RateLimited("mcp", 429, 5))).toEqual({
      kind: "rate-limited",
      detail: "RateLimited (429)",
    });
    expect(classifyIncident(new HourlyRequestLimit("mcp", 30)).kind).toBe("request-limit");
    expect(classifyIncident(new DailyRequestLimit("mcp", 200)).kind).toBe("request-limit");
    expect(classifyIncident(new McpLoginRequired()).kind).toBe("login-required");
    expect(classifyIncident(new McpTransportFailure("TypeError"))).toEqual({
      kind: "transport-failure",
      detail: "McpTransportFailure (TypeError)",
    });
    const other = classifyIncident(new Error("secret https://x?key=abc"));
    expect(other).toEqual({ kind: "other", detail: "Error" });
    expect(JSON.stringify(other)).not.toContain("secret");
  });
});

describe("the watch and the store", () => {
  const inner = (failOn: (n: number) => Error | McpCallResult | undefined) =>
    new InfraWatchMcp(
      new Scripted(
        { name: "fake", tools: async () => [], call: async () => ({ isError: false, text: "{}" }) },
        failOn,
      ),
    );

  it("lets a healthy session through to the record", () => {
    const watch = inner(() => undefined);
    const store = new MemoryRecordStore();
    new AbortOnIncidentStore(store, watch).append(record("a"));
    expect(store.forWindow("2026-10-20")).toHaveLength(1);
  });

  it("rethrows the failure to the loop, and then refuses to record that session", async () => {
    const watch = inner((n) => (n === 2 ? new RateLimited("mcp", 429, 5) : undefined));
    const store = new MemoryRecordStore();
    await watch.call("timeseries_data", {});
    await expect(watch.call("timeseries_data", {})).rejects.toBeInstanceOf(RateLimited);
    expect(() => new AbortOnIncidentStore(store, watch).append(record("a", "sonnet"))).toThrow(
      McpSessionsAborted,
    );
    expect(store.forWindow("2026-10-20")).toHaveLength(0);
  });

  it("clears the incident once it has been reported, so the next session is judged on its own", () => {
    const watch = inner((n) => (n === 1 ? new McpTransportFailure("TypeError") : undefined));
    const store = new MemoryRecordStore();
    const guarded = new AbortOnIncidentStore(store, watch);
    return watch
      .call("timeseries_data", {})
      .catch(() => undefined)
      .then(() => {
        expect(() => guarded.append(record("a"))).toThrow(/transport|McpTransportFailure/);
        guarded.append(record("b"));
        expect(store.forWindow("2026-10-20").map((r) => r.instance)).toEqual(["b"]);
      });
  });

  it("does not treat an error RESULT from the server as an incident: that is the model's to handle", async () => {
    const watch = inner((n) => (n === 1 ? { isError: true, text: "unknown model" } : undefined));
    const store = new MemoryRecordStore();
    expect(await watch.call("timeseries_data", {})).toEqual({
      isError: true,
      text: "unknown model",
    });
    new AbortOnIncidentStore(store, watch).append(record("a"));
    expect(store.forWindow("2026-10-20")).toHaveLength(1);
  });
});

const fastGovernor = () =>
  new RateGovernor({
    overrides: {
      mcp: { minIntervalMs: 0 },
      "data-api": { minIntervalMs: 0, baseBackoffMs: 1, maxBackoffMs: 1, maxRetries: 1 },
    },
  });

describe("a scheduled day on the fake server: an outage is not a result about a model", () => {
  let f: FixtureDay;
  let tmp: string;
  beforeAll(async () => {
    f = await fixtureDay(undefined, {}, LIVE_LAG);
  });
  afterAll(() => f.cleanup());
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cr-live-run-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const SEED = "5".repeat(64);
  const seat = standInSeat("solver", { id: "stand-in-researcher", provider: "anthropic" });
  const instances = () =>
    drawInstances(f.day, SEED, 1)
      .filter((i) => i.task === "CR-SM")
      .map((i) => toMcpInstance(i, f.day)?.instance)
      .filter((i): i is NonNullable<typeof i> => i !== undefined);

  const deps = (
    records: MemoryRecordStore,
    backend: McpBackend & { close(): Promise<void> },
  ): LiveMcpRunDeps => {
    const api = routedStandInApi(
      "researcher",
      instances(),
      f.day,
      (i) => buildMcpPrompt(i, f.day.window).text,
    );
    return {
      store: f.store,
      records,
      ledger: new SpendLedger({
        store: new MemoryLedgerStore(),
        policy: {
          dailyCapUsd: "9",
          providers: { anthropic: { budgetUsd: "100", since: "2026-01-01T00:00:00Z" } },
        },
      }),
      seeds: new SeedBook({
        publicDir: join(tmp, "pub"),
        privateDir: join(tmp, "priv"),
        newSeed: () => SEED,
      }),
      seats: [seat],
      chatFor: (s) => anthropicChat(api, s.modelString),
      // the key pull (D117) goes through the data desk the run is given, over the same governor, and sees the data a day later than the day's snapshot did
      connect: async (g) => ({
        mcp: backend,
        desk: new DataDesk({
          backend: new FixtureBackend({ lagByModel: LIVE_LAG }),
          store: f.store,
          governor: g,
        }),
      }),
      governor: fastGovernor(),
      tasks: ["CR-SM"],
      sessionsDir: join(tmp, "sessions"),
    };
  };
  const healthy = () =>
    new Scripted(
      new FakeMcp({ backend: f.backend, today: f.day.window, lagByModel: LIVE_LAG }),
      () => undefined,
    );

  it("a day that meets no failure records its sessions and reports itself complete", async () => {
    const records = new MemoryRecordStore();
    const tally = { requests: 0 };
    const s = await runLiveMcpDay(f.day.window, deps(records, healthy()), () => undefined, tally);
    expect(s.complete).toBe(true);
    expect(records.forWindow(f.day.window)).toHaveLength(1);
  });

  it("a rate limit that outlasts the retries aborts the run WITHOUT recording the session, and the next run plays it again", async () => {
    const records = new MemoryRecordStore();
    const flaky = new Scripted(
      new FakeMcp({ backend: f.backend, today: f.day.window, lagByModel: LIVE_LAG }),
      (n) => (n === 1 ? new RateLimited("mcp", 429, 5) : undefined),
    );
    await expect(
      runLiveMcpDay(f.day.window, deps(records, flaky), () => undefined, { requests: 0 }),
    ).rejects.toBeInstanceOf(McpSessionsAborted);
    expect(records.forWindow(f.day.window)).toHaveLength(0);

    // the same instance and model are still to run, and run cleanly once the service is back
    const again = await runLiveMcpDay(f.day.window, deps(records, healthy()), () => undefined, {
      requests: 0,
    });
    expect(again.alreadyRecorded).toBe(0);
    expect(again.complete).toBe(true);
    expect(records.forWindow(f.day.window)).toHaveLength(1);
  });

  it("a dropped connection is the same: not recorded, retried", async () => {
    const records = new MemoryRecordStore();
    const flaky = new Scripted(
      new FakeMcp({ backend: f.backend, today: f.day.window, lagByModel: LIVE_LAG }),
      (n) => (n === 1 ? new McpTransportFailure("TypeError") : undefined),
    );
    await expect(
      runLiveMcpDay(f.day.window, deps(records, flaky), () => undefined, { requests: 0 }),
    ).rejects.toThrow(/McpTransportFailure/);
    expect(records.forWindow(f.day.window)).toHaveLength(0);
  });

  it("counts the live requests, the MCP's tool calls and the Data API pulls of the answer key, even when the run ends on a failure, so retries cannot add up past the day's ceiling", async () => {
    // a store of its own, so the answer key is pulled rather than found from an earlier test
    const g = await fixtureDay(undefined, {}, LIVE_LAG);
    try {
      const records = new MemoryRecordStore();
      const governor = fastGovernor();
      const tally = { requests: 0 };
      const keyBackend = new FixtureBackend({ lagByModel: LIVE_LAG });
      // the MCP does its calls through the governor, as the live one does, and the service fails on the first
      const inner = healthy();
      let n = 0;
      const counted: McpBackend & { close(): Promise<void> } = {
        name: "fake",
        tools: () => inner.tools(),
        call: async (name, args) => {
          const value = await governor.run("mcp", async () => ({
            status: 200,
            value: await inner.call(name, args),
          }));
          if (++n === 1) throw new RateLimited("mcp", 429, 5);
          return value;
        },
        close: async () => {},
      };
      await expect(
        runLiveMcpDay(
          g.day.window,
          {
            ...deps(records, counted),
            store: g.store,
            governor,
            connect: async (gov) => ({
              mcp: counted,
              desk: new DataDesk({ backend: keyBackend, store: g.store, governor: gov }),
            }),
          },
          () => undefined,
          tally,
        ),
      ).rejects.toBeInstanceOf(McpSessionsAborted);
      expect(keyBackend.requests.length).toBeGreaterThan(0);
      expect(tally.requests).toBe(1 + keyBackend.requests.length);
    } finally {
      g.cleanup();
    }
  });
});
