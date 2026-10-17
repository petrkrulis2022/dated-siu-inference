import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REASONING_BUDGET_MULTIPLE, type Adapter } from "@touchstone/harness";
import { D } from "@touchstone/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import type { SpendPolicy } from "../spend/types.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { INSTANCES_PER_TASK, TASKS } from "../tasks/instances.js";
import { SeedBook, verifyRecord } from "../tasks/seeds.js";
import { MemoryRecordStore, FileRecordStore, type RecordStore } from "./records.js";
import { MAX_OUTPUT_TOKENS, type Seat } from "./run-answer.js";
import { daySha256, runDay, writeTables } from "./run-day.js";
import { standInSeat } from "./stand-in-models.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const POLICY: SpendPolicy = {
  dailyCapUsd: "9",
  providers: { anthropic: { budgetUsd: "100", since: "2026-10-01T00:00:00Z" } },
};

let f: FixtureDay;
let tmp: string;
beforeAll(async () => {
  f = await fixtureDay();
});
afterAll(() => f.cleanup());
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cr-run-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const world = (
  policy: SpendPolicy = POLICY,
): { ledger: SpendLedger; seeds: SeedBook; records: RecordStore } => ({
  ledger: new SpendLedger({ store: new MemoryLedgerStore(), policy, now: () => NOW }),
  seeds: new SeedBook({
    publicDir: join(tmp, "pub"),
    privateDir: join(tmp, "priv"),
    now: () => NOW,
    newSeed: () => "a1".repeat(32),
  }),
  records: new MemoryRecordStore(),
});
const input = (w: ReturnType<typeof world>, seats: Seat[], extra = {}) => ({
  window: f.day.window,
  day: f.day,
  daySha256: daySha256(f.store, f.day.window),
  seats,
  now: () => NOW,
  ...w,
  ...extra,
});

describe("a day of snapshot mode", () => {
  it("asks every seat every drawn instance once, grades each, and reveals the seed when the window is complete", async () => {
    const w = world();
    const summary = await runDay(input(w, [standInSeat("solver")]));
    const planned = TASKS.length * INSTANCES_PER_TASK - 1; // CR-SM has two
    expect(summary).toMatchObject({
      planned,
      alreadyRecorded: 0,
      attempted: planned,
      passed: planned,
      complete: true,
      seedRevealed: true,
    });
    expect(summary.stopped).toBeUndefined();
    const rows = w.records.forWindow(f.day.window);
    expect(rows).toHaveLength(planned);
    expect(
      rows.every((r) => r.passed && r.failure_classes.length === 0 && r.part === "snapshot"),
    ).toBe(true);
    expect(
      rows.every((r) => r.key === "CR_ANTHROPIC_API_KEY" && /^[0-9a-f]{64}$/.test(r.prompt_sha256)),
    ).toBe(true);
    expect(new Set(rows.map((r) => r.day_sha256)).size).toBe(1);
    const seed = w.seeds.record(f.day.window);
    expect(seed?.seed).toBeDefined();
    expect(seed && verifyRecord(seed)).toBe(true);
  });

  it("records the billed cost from the usage the adapter reported, priced exactly, and the ledger agrees", async () => {
    const w = world();
    await runDay(
      input(
        w,
        [standInSeat("solver", { price: { priceInUsdPer1M: "2", priceOutUsdPer1M: "10" } })],
        { tasks: ["CR-UO"] },
      ),
    );
    const rows = w.records.forWindow(f.day.window);
    for (const r of rows) {
      const want = new D(r.tokens.input)
        .div(1_000_000)
        .times(2)
        .plus(new D(r.tokens.output).div(1_000_000).times(10));
      expect(new D(r.usd).eq(want), r.instance).toBe(true);
    }
    const total = rows.reduce((a, r) => a.plus(r.usd), new D(0));
    expect(new D(w.ledger.report().spentToday).minus(total).abs().lte("0.000001")).toBe(true);
  });

  it("every damaged stand-in lands in its own taxonomy class, and a failed call costs nothing", async () => {
    const w = world();
    const seats = (["solver", "sloppy", "fenced", "silent", "failing", "truncating"] as const).map(
      (k) => standInSeat(k),
    );
    const s = await runDay(input(w, seats));
    expect(s.complete).toBe(true);
    const rows = w.records.forWindow(f.day.window);
    const of = (m: string) => rows.filter((r) => r.model === `stand-in-${m}`);
    expect(of("solver").every((r) => r.passed)).toBe(true);
    expect(of("fenced").every((r) => r.passed && r.fenced)).toBe(true);
    expect(of("silent").every((r) => !r.passed && r.primary_failure === "no-output")).toBe(true);
    expect(of("truncating").every((r) => r.primary_failure === "truncated")).toBe(true);
    const failing = of("failing");
    expect(
      failing.every(
        (r) =>
          r.primary_failure === "call-failed" &&
          r.usd === "0" &&
          r.error === "AdapterHttpError HTTP 429",
      ),
    ).toBe(true);
    const byTask = Object.fromEntries(of("sloppy").map((r) => [r.task, r.primary_failure]));
    expect(byTask).toEqual({
      "CR-VS": "missing-items",
      "CR-PL": "arithmetic",
      "CR-UO": "scale-slip",
      "CR-SM": "ordering",
    });
  });

  it("an error never leaks its message or body into a record", async () => {
    const w = world();
    const leaky: Adapter = async () => {
      throw Object.assign(new Error('401 for key sk-ant-SECRET-VALUE with body {"data":123}'), {
        status: 401,
        name: "AdapterHttpError",
      });
    };
    const seat = { ...standInSeat("solver"), adapter: leaky };
    await runDay(input(w, [seat], { tasks: ["CR-UO"] }));
    const text = JSON.stringify(w.records.forWindow(f.day.window));
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("sk-ant");
    expect(text).toContain("AdapterHttpError HTTP 401");
  });

  it("resumes: a stopped run, run again, asks only what is missing, never twice, and reveals the seed only at the end", async () => {
    const w = world();
    const seat = standInSeat("solver");
    const first = await runDay(input(w, [seat], { maxAnswers: 4 }));
    expect(first).toMatchObject({ attempted: 4, complete: false, seedRevealed: false });
    expect(w.seeds.record(f.day.window)?.seed).toBeUndefined();
    const second = await runDay(input(w, [seat]));
    expect(second.alreadyRecorded).toBe(4);
    expect(second.attempted).toBe(second.planned - 4);
    expect(second).toMatchObject({ complete: true, seedRevealed: true });
    const keys = w.records.forWindow(f.day.window).map((r) => `${r.instance}|${r.model}`);
    expect(new Set(keys).size).toBe(keys.length);
    const third = await runDay(input(w, [seat]));
    expect(third).toMatchObject({ attempted: 0, complete: true });
  });

  it("a dry run is recorded apart from the counted run and never reveals the seed", async () => {
    const w = world();
    const s = await runDay(
      input(w, [standInSeat("solver")], { part: "dry-run", tasks: ["CR-UO"] }),
    );
    expect(s).toMatchObject({ part: "dry-run", complete: true, seedRevealed: false });
    expect(w.records.forWindow(f.day.window).every((r) => r.part === "dry-run")).toBe(true);
    const counted = await runDay(input(w, [standInSeat("solver")], { tasks: ["CR-UO"] }));
    expect(counted.alreadyRecorded).toBe(0);
  });
});

/**
 * The proof the owner asked for: the spend guard halts the run BEFORE the cap, not after it. A stand-in adapter counts how many times it is really called, so "never started" is
 * observed, not assumed. Prices are chosen so every number is exact: input is free and output costs $1 per million tokens, so a call's projection is the full output allowance
 * (and the retry the adapters may make at a larger budget), while its actual cost is whatever the adapter reports.
 */
describe("the spend guard halts the run before the cap", () => {
  const PRICE = { priceInUsdPer1M: "0", priceOutUsdPer1M: "1" };
  const ACTUAL_OUT = 3000;
  const actual = new D(ACTUAL_OUT).div(1_000_000);
  const projection = new D(MAX_OUTPUT_TOKENS["CR-UO"] * (1 + REASONING_BUDGET_MULTIPLE)).div(
    1_000_000,
  );

  function countingSeat(provider: Seat["provider"] = "anthropic") {
    const base = standInSeat("solver", { price: PRICE, provider });
    const calls = { n: 0 };
    const adapter: Adapter = async (m, p, params) => {
      calls.n += 1;
      const r = await base.adapter(m, p, params);
      return { ...r, usage: { ...r.usage, input: 0, output: ACTUAL_OUT } };
    };
    return { seat: { ...base, adapter } as Seat, calls };
  }

  it("stops at the daily cap: calls recorded + the refused one's projection would pass the cap, so it never starts", async () => {
    // room for exactly four calls: after n calls spent = n x actual, and a call may start while spent + projection <= cap
    const cap = projection.plus(actual.times(3));
    const w = world({ ...POLICY, dailyCapUsd: cap.toFixed() });
    const { seat, calls } = countingSeat();
    const s = await runDay(input(w, [seat], { tasks: ["CR-UO"], perTask: 10 }));

    expect(s.stopped?.code).toBe("daily-cap");
    expect(s.attempted).toBe(4);
    expect(calls.n).toBe(4); // the fifth was refused before it was made
    expect(w.records.forWindow(f.day.window)).toHaveLength(4);
    const spent = new D(w.ledger.report().spentToday);
    expect(spent.eq(actual.times(4))).toBe(true);
    expect(spent.lte(cap)).toBe(true); // never above the cap
    expect(spent.plus(projection).gt(cap)).toBe(true); // and the next call could not have fitted
    expect(s.complete).toBe(false);
    expect(s.seedRevealed).toBe(false);
  });

  it("stops at a provider's budget, with the provider named", async () => {
    const budget = projection.plus(actual.times(1));
    const w = world({
      dailyCapUsd: "9",
      providers: { anthropic: { budgetUsd: budget.toFixed(), since: "2026-10-01T00:00:00Z" } },
    });
    const { seat, calls } = countingSeat();
    const s = await runDay(input(w, [seat], { tasks: ["CR-UO"], perTask: 10 }));
    expect(s.stopped).toMatchObject({ code: "provider-budget", provider: "anthropic" });
    expect(calls.n).toBe(2);
    expect(new D(w.ledger.report().spentToday).lte(budget)).toBe(true);
  });

  it("fails closed with no recorded balance: nothing is called, nothing recorded", async () => {
    const w = world({ dailyCapUsd: "9", providers: {} });
    const { seat, calls } = countingSeat();
    const s = await runDay(input(w, [seat], { tasks: ["CR-UO"] }));
    expect(s.stopped?.code).toBe("no-budget");
    expect(calls.n).toBe(0);
    expect(w.records.forWindow(f.day.window)).toHaveLength(0);
    expect(w.ledger.report().spentToday).toBe("0.000000");
  });

  it("with answers in flight at once the cap still holds: reservations count before the call is made", async () => {
    const cap = projection.plus(actual.times(3));
    const w = world({ ...POLICY, dailyCapUsd: cap.toFixed() });
    const { seat, calls } = countingSeat();
    await runDay(input(w, [seat], { tasks: ["CR-UO"], perTask: 10, concurrency: 4 }));
    const spent = new D(w.ledger.report().spentToday);
    expect(spent.lte(cap)).toBe(true);
    expect(calls.n).toBe(w.records.forWindow(f.day.window).length);
    expect(calls.n).toBeLessThanOrEqual(4);
  });

  it("one provider's budget does not release another's: the stop is per provider", async () => {
    const w = world({
      dailyCapUsd: "9",
      providers: { anthropic: { budgetUsd: "100", since: "2026-10-01T00:00:00Z" } },
    });
    const ok = countingSeat("anthropic");
    const noBudget = countingSeat("openai");
    const s = await runDay(input(w, [ok.seat, noBudget.seat], { tasks: ["CR-UO"], perTask: 2 }));
    expect(s.stopped?.code).toBe("no-budget");
    expect(noBudget.calls.n).toBe(0);
  });
});

describe("tables and files", () => {
  it("writes the daily, cumulative and failure tables, and the records file round-trips", async () => {
    const dir = join(tmp, "records");
    const records = new FileRecordStore(dir);
    const w = { ...world(), records };
    const seats = [standInSeat("solver"), standInSeat("sloppy")];
    await runDay(input(w, seats));
    expect(readdirSync(dir)).toEqual([`${f.day.window}.jsonl`]);
    expect(records.forWindow(f.day.window).length).toBeGreaterThan(0);
    expect(records.windows()).toEqual([f.day.window]);
    const out = join(tmp, "tables");
    const files = writeTables(records, f.day.window, "snapshot", out);
    expect(files.map((p) => p.split("/").pop())).toEqual([
      `daily-snapshot-${f.day.window}.md`,
      "cumulative-snapshot.md",
      `failures-snapshot-${f.day.window}.md`,
    ]);
    const daily = readFileSync(files[0] as string, "utf-8");
    expect(daily).toContain("| stand-in-solver |");
    expect(daily).toContain("**all models**");
    expect(readFileSync(files[2] as string, "utf-8")).toContain("scale-slip");
  });
});
