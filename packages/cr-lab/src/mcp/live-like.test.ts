/**
 * The fixtures made to behave like the live data where it matters to MCP mode: the stablecoin series publish a day late, and the volume question is asked over three months (D105).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "../data-desk/dates.js";
import { referenceAnswerJson } from "../runner/prompts.js";
import { standInSeat } from "../runner/stand-in-models.js";
import { MemoryRecordStore } from "../runner/records.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance } from "../tasks/instances.js";
import { SeedBook } from "../tasks/seeds.js";
import { smRows, solveVS, vsMonthly } from "../tasks/solve.js";
import { FakeMcp, LIVE_LAG } from "./fake-mcp.js";
import { buildMcpPrompt } from "./prompts.js";
import { dayFromRelayed, gradeMcpAnswer, type RelayedCall } from "./relayed.js";
import { runMcpAnswer, runMcpDay } from "./session.js";
import { readPlan, routedStandInApi, standInMessagesApi } from "./stand-in-agent.js";
import { MCP_VS_MONTHS, toMcpInstance } from "./variants.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let f: FixtureDay;
let all: Instance[];
beforeAll(async () => {
  f = await fixtureDay(undefined, {}, LIVE_LAG);
  all = drawInstances(f.day, "3".repeat(64));
});
afterAll(() => f.cleanup());
const W = () => f.day.window;
const mcp = () => new FakeMcp({ backend: f.backend, today: W(), lagByModel: LIVE_LAG });
const run = async (calls: [string, Record<string, unknown>][]): Promise<RelayedCall[]> => {
  const m = mcp();
  const out: RelayedCall[] = [];
  for (const [tool, args] of calls) out.push({ tool, args, ...(await m.call(tool, args)) });
  return out;
};

describe("stablecoin series that publish a day late", () => {
  it("the snapshot's own stablecoin data ends the day before the snapshot day, as the live data does", () => {
    const { end } = smRows(f.day, "chain");
    expect(end).toBe(addDays(W(), -1));
  });

  it("a model's natural `timeframe: 90d` gives the question's window exactly, as it does on the live data", async () => {
    const sm = all.find((i) => i.task === "CR-SM") as Extract<Instance, { task: "CR-SM" }>;
    const model =
      sm.params.dimension === "chain" ? "stablecoins-by-chain" : "stablecoins-by-issuer";
    const ids = [...f.day.stablecoins[sm.params.dimension].keys()];
    const chunks = Array.from({ length: Math.ceil(ids.length / 10) }, (_, k) =>
      ids.slice(k * 10, k * 10 + 10),
    );
    const relayed = await run(
      chunks.map((series) => [
        "timeseries_data",
        { model, granularity: "1d", series, timeframe: "90d", bounds: true },
      ]),
    );
    const g = gradeMcpAnswer({
      instance: sm,
      text: referenceAnswerJson(sm),
      relayed: dayFromRelayed(W(), relayed),
    });
    expect(g.snapshotCheck).toBe("same");
    expect(g.passed).toBe(true);
  });

  it("other models are not lagged: volume and lending still end on the snapshot day", async () => {
    const r = await mcp().call("timeseries_data", {
      model: "perp-dex-protocols",
      granularity: "1d",
      series: [f.backend.world.venues[0]?.id],
      timeframe: "5d",
    });
    const last = JSON.parse(r.text).series[0].points.at(-1)[0] as number;
    expect(new Date(last * 1000).toISOString().slice(0, 10)).toBe(W());
  });
});

describe("the volume question in MCP mode: the last three complete months", () => {
  const vs = () => all.find((i) => i.task === "CR-VS") as Extract<Instance, { task: "CR-VS" }>;

  it("is the same question over three months, keyed the same way, and the variant is named", () => {
    const v = toMcpInstance(vs(), f.day);
    expect(v?.variant).toBe("vs-3-months");
    const inst = v?.instance as Extract<Instance, { task: "CR-VS" }>;
    expect(inst.params).toEqual({ endMonth: vs().params.endMonth, months: MCP_VS_MONTHS });
    expect(inst.reference.months).toHaveLength(3);
    expect(inst.reference).toEqual(solveVS(f.day, vs().params.endMonth, 3));
    expect(vsMonthly(f.day, vs().params.endMonth, 3).months).toHaveLength(3);
    // the other tasks are unchanged
    for (const i of all.filter((x) => x.task !== "CR-VS"))
      expect(toMcpInstance(i, f.day)).toEqual({ instance: i });
  });

  it("the MCP prompt says three months and lists exactly the three month keys", () => {
    const inst = toMcpInstance(vs(), f.day)?.instance as Instance;
    const p = buildMcpPrompt(inst, W()).text;
    expect(p).toContain("three calendar months");
    expect(p).toContain("those three months");
    expect(p).not.toContain("twelve");
    expect(p).toContain("The three month keys are");
  });

  it("reading three months takes about a quarter of the data that twelve does, and the careful agent passes", async () => {
    const inst = toMcpInstance(vs(), f.day)?.instance as Extract<Instance, { task: "CR-VS" }>;
    const three = await run(readPlan(inst, f.day));
    const twelve = await run(readPlan(vs(), f.day));
    const size = (r: RelayedCall[]) => r.reduce((n, c) => n + c.text.length, 0);
    expect(size(three)).toBeLessThan(size(twelve) / 3);
    const g = gradeMcpAnswer({
      instance: inst,
      text: referenceAnswerJson(inst),
      relayed: dayFromRelayed(W(), three),
    });
    expect(g.passed).toBe(true);
  });

  it("a twelve-month answer to the three-month question does not pass", async () => {
    const inst = toMcpInstance(vs(), f.day)?.instance as Instance;
    const relayed = dayFromRelayed(
      W(),
      await run(readPlan(inst as Extract<Instance, { task: "CR-VS" }>, f.day)),
    );
    const g = gradeMcpAnswer({ instance: inst, text: referenceAnswerJson(vs()), relayed });
    expect(g.passed).toBe(false);
  });
});

describe("a day of MCP mode on the live-like fixtures", () => {
  it("runs the three tasks, with the volume question over three months and the variant recorded", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cr-ll-"));
    try {
      const instances = drawInstances(f.day, "4".repeat(64), 1).map(
        (i) => toMcpInstance(i, f.day)?.instance as Instance,
      );
      const seat = standInSeat("solver", { id: "claude-haiku-4-5", provider: "anthropic" });
      const records = new MemoryRecordStore();
      const NOW = new Date("2026-10-20T12:00:00Z");
      const summary = await runMcpDay({
        window: W(),
        day: f.day,
        daySha256: "d".repeat(64),
        seats: [seat],
        ledger: new SpendLedger({
          store: new MemoryLedgerStore(),
          policy: {
            dailyCapUsd: "9",
            providers: { anthropic: { budgetUsd: "100", since: "2026-10-01T00:00:00Z" } },
          },
          now: () => NOW,
        }),
        seeds: new SeedBook({
          publicDir: join(tmp, "p"),
          privateDir: join(tmp, "q"),
          now: () => NOW,
          newSeed: () => "4".repeat(64),
        }),
        records,
        mcp: mcp(),
        apiFor: () =>
          routedStandInApi("researcher", instances, f.day, (i) => buildMcpPrompt(i, W()).text),
        sessionsDir: tmp,
        now: () => NOW,
      });
      expect(summary).toMatchObject({ planned: 3, attempted: 3, passed: 3, complete: true });
      const rows = records.forWindow(W());
      expect(rows.find((r) => r.task === "CR-VS")?.mcp?.variant).toBe("vs-3-months");
      expect(rows.find((r) => r.task === "CR-PL")?.mcp?.variant).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("the cost trap: a read that names no metrics", () => {
  it("brings back every metric the model has, and the volume read is many times bigger and dearer than a careful one", async () => {
    const vs = all.find((i) => i.task === "CR-VS") as Instance;
    const inst = toMcpInstance(vs, f.day)?.instance as Extract<Instance, { task: "CR-VS" }>;
    const tmp = mkdtempSync(join(tmpdir(), "cr-trap-"));
    try {
      const NOW = new Date("2026-10-20T12:00:00Z");
      const session = async (kind: "researcher" | "careless") => {
        const api = standInMessagesApi(kind, inst, f.day);
        return runMcpAnswer({
          api,
          mcp: mcp(),
          ledger: new SpendLedger({
            store: new MemoryLedgerStore(),
            policy: {
              dailyCapUsd: "9",
              providers: { anthropic: { budgetUsd: "100", since: "2026-10-01T00:00:00Z" } },
            },
            now: () => NOW,
          }),
          seat: standInSeat("solver", {
            id: "claude-sonnet-5",
            provider: "anthropic",
            price: { priceInUsdPer1M: "2", priceOutUsdPer1M: "10" },
          }),
          instance: inst,
          window: W(),
          daySha256: "d".repeat(64),
          sessionsDir: tmp,
          now: () => NOW,
        });
      };
      const careful = (await session("researcher")).record;
      const careless = (await session("careless")).record;
      const bytes = (r: typeof careful) =>
        (r.mcp?.tool_calls ?? [])
          .filter((c) => c.tool === "timeseries_data")
          .reduce((n, c) => n + c.result_bytes, 0);
      expect(careful.passed).toBe(true);
      expect(bytes(careless)).toBeGreaterThan(20 * bytes(careful));
      // so large that the session ends on the size of the conversation before it can answer
      expect(careless.passed).toBe(false);
      expect(careless.mcp?.limit).toBe("context-limit");
      expect(careless.primary_failure).toBe("session-limit");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
