import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapter, AdapterParams } from "@touchstone/harness";
import { buildPrompt, referenceAnswerJson } from "../runner/prompts.js";
import { standInSeat } from "../runner/stand-in-models.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance } from "../tasks/instances.js";
import {
  REPLY_LINE,
  WORKING_LINE,
  readResult,
  regradeWorkingRow,
  runProbe,
  stripWorking,
  tally,
  thinkingBudget,
  workingFieldPrompt,
  type ProbeItem,
} from "./haiku-probe.js";

let f: FixtureDay;
let items: ProbeItem[];
beforeAll(async () => {
  f = await fixtureDay();
  items = drawInstances(f.day, "8".repeat(64), 1)
    .filter((i) => i.task !== "CR-UO")
    .map((instance) => ({
      instance,
      bundle: buildPrompt(instance, f.day) as NonNullable<ReturnType<typeof buildPrompt>>,
      window: f.day.window,
      daySha256: "d".repeat(64),
    }));
});
afterAll(() => f.cleanup());

const ALLOWANCES = { "CR-VS": 32000, "CR-PL": 20000, "CR-UO": 4000, "CR-SM": 4000 } as const;
const ledger = () =>
  new SpendLedger({
    store: new MemoryLedgerStore(),
    policy: {
      dailyCapUsd: "9",
      providers: { anthropic: { budgetUsd: "100", since: "2026-01-01T00:00:00Z" } },
    },
  });

describe("the working-field prompt changes the one reply instruction and nothing else", () => {
  it("replaces that line and leaves every other byte of the counted prompt alone", () => {
    const text = items[0]?.bundle.text as string;
    const changed = workingFieldPrompt(text);
    expect(changed).toContain(WORKING_LINE);
    expect(changed).not.toContain(`${REPLY_LINE}\n`);
    expect(changed.replace(WORKING_LINE, REPLY_LINE)).toBe(text);
  });

  it("refuses a prompt that does not hold the instruction, rather than sending something else", () => {
    expect(() => workingFieldPrompt("no instruction here")).toThrow(/reply instruction/);
  });
});

describe("removing the working before the gate reads the reply", () => {
  it("takes out a top-level working string and keeps every figure exactly as written", () => {
    const reply =
      '{"working": "12.5 + 0.25 = 12.75", "fees": 0.123456789012345678901234, "payouts": "7", "revenue": 1e3}';
    const out = stripWorking(reply);
    expect(JSON.parse(out)).toEqual({ fees: 0.12345678901234568, payouts: "7", revenue: 1000 });
    expect(out).toContain("0.123456789012345678901234"); // the digits are the model's, not a rounded float
    expect(out).not.toContain("working");
  });

  it("reads a fenced reply as the gate does: the working is taken out and the fence stays, so the answer is still flagged fenced (the first probe row, 2026-10-20)", () => {
    const out = stripWorking('```json\n{\n  "working": "Step 1",\n  "fees": "1.50"\n}\n```');
    expect(out).toBe('```json\n{"fees":"1.50"}\n```');
    // and a fenced reply with no working is left alone
    expect(stripWorking('```json\n{"fees": 1}\n```')).toBe('```json\n{"fees": 1}\n```');
  });

  it("leaves a reply with no working, text that is not JSON and nested working as they are", () => {
    for (const same of [
      '{"fees": 1}',
      "I think the answer is 4",
      '{"answer": {"working": "x"}}',
      '{"working": 5, "fees": 1}',
      "{broken",
    ])
      expect(stripWorking(same)).toBe(same);
  });
});

describe("re-grading a stored working-field reply", () => {
  it("grades the same reply with the working taken out, keeping cost and tokens, and says so on the row", async () => {
    const item = items.find((i) => i.instance.task === "CR-PL") as ProbeItem;
    const answer = JSON.parse(referenceAnswerJson(item.instance)) as Record<string, unknown>;
    const reply = "```json\n" + JSON.stringify({ working: "x", ...answer }) + "\n```";
    const wrong = {
      condition: "working-field" as const,
      record: {
        passed: false,
        fenced: false,
        failure_classes: ["schema"],
        failures: [{ code: "schema", detail: "x" }],
        primary_failure: "schema",
        usd: "0.0112",
        tokens: { input: 5332, output: 1165, reasoning: 0, cached_input: 0 },
        deviations: [],
        raw_output: reply,
      },
    } as never;
    const row = regradeWorkingRow(wrong, item.instance, reply);
    expect(row.record.passed).toBe(true);
    expect(row.record.fenced).toBe(true);
    expect(row.record.failure_classes).toEqual([]);
    expect(row.record.primary_failure).toBeUndefined();
    expect(row.record.usd).toBe("0.0112");
    expect(row.record.deviations.at(-1)).toMatch(/regraded offline/);
  });
});

describe("the thinking budget", () => {
  it("is the allowance less 2,000 tokens for the answer, never under the API's minimum of 1,024", () => {
    expect(thinkingBudget(32000)).toBe(30000);
    expect(thinkingBudget(20000)).toBe(18000);
    expect(thinkingBudget(4000)).toBe(2000);
    expect(thinkingBudget(2500)).toBe(1024);
  });
});

describe("running the probe", () => {
  const instanceOf = (task: Instance["task"]) =>
    items.find((i) => i.instance.task === task) as ProbeItem;
  /** an adapter that answers correctly, with a working field first, and notes what it was sent */
  const spy = () => {
    const calls: { prompt: string; params: AdapterParams }[] = [];
    const adapter: Adapter = async (_m, prompt, params) => {
      calls.push({ prompt, params });
      const instance = items.find(
        (i) => prompt === i.bundle.text || prompt === workingFieldPrompt(i.bundle.text),
      )?.instance as Instance;
      const answer = JSON.parse(referenceAnswerJson(instance)) as Record<string, unknown>;
      const withWork = prompt.includes(WORKING_LINE)
        ? { working: "step by step", ...answer }
        : answer;
      return {
        text: JSON.stringify(withWork),
        usage: { input: 2000, output: 300, cached_input: 0, reasoning: 0 },
        latency_ms: 1,
        raw: {},
        deviations: [],
        sent: { temperature: 0 },
      } as never;
    };
    return { calls, adapter };
  };

  it("sends each condition exactly what it is defined to send, and the gate passes a correct answer in both", async () => {
    const { calls, adapter } = spy();
    const kept: string[] = [];
    const res = await runProbe({
      seat: { ...standInSeat("solver", { id: "claude-haiku-4-5" }), adapter },
      ledger: ledger(),
      items: [instanceOf("CR-VS")],
      allowances: ALLOWANCES,
      keepReply: (c, i, text) => kept.push(`${c}:${i.id}:${text.length}`),
    });
    expect(res.rows.map((r) => r.condition)).toEqual(["working-field", "thinking"]);
    expect(res.rows.every((r) => r.record.passed)).toBe(true);
    expect(res.rows.every((r) => r.record.part === "dry-run")).toBe(true);
    const [wf, th] = calls;
    expect(wf?.prompt).toContain(WORKING_LINE);
    expect(wf?.params.thinking).toBeUndefined();
    expect(wf?.params.max_tokens).toBe(32000);
    expect(th?.prompt).toBe(instanceOf("CR-VS").bundle.text); // the counted prompt, byte for byte
    expect(th?.params).toMatchObject({
      omit_temperature: true,
      thinking: { mode: "manual", budget_tokens: 30000 },
      max_tokens: 32000,
    });
    // the model's whole working-field reply is kept before the working is removed
    expect(kept.some((k) => k.startsWith("working-field:"))).toBe(true);
    // the record's prompt hash is the prompt actually sent
    expect(res.rows[0]?.record.prompt_sha256).not.toBe(instanceOf("CR-VS").bundle.promptSha256);
    expect(res.rows[1]?.record.prompt_sha256).toBe(instanceOf("CR-VS").bundle.promptSha256);
  });

  it("books each call against the ledger under its own condition, so a probe's spend is never taken for a counted answer's", async () => {
    const { adapter } = spy();
    const booked: string[] = [];
    const real = ledger();
    const wrapped = {
      guard: (p: never, projected: never, meta: { what: string }, fn: never) => {
        booked.push(meta.what);
        return (real.guard as (...a: unknown[]) => unknown)(p, projected, meta, fn);
      },
    } as unknown as SpendLedger;
    await runProbe({
      seat: { ...standInSeat("solver", { id: "claude-haiku-4-5" }), adapter },
      ledger: wrapped,
      items: [instanceOf("CR-PL")],
      allowances: ALLOWANCES,
    });
    expect(booked).toEqual([
      `${instanceOf("CR-PL").instance.id}#probe-working-field`,
      `${instanceOf("CR-PL").instance.id}#probe-thinking`,
    ]);
  });

  it("stops before a call that could pass the cap, leaving both conditions with the same instances", async () => {
    const { adapter, calls } = spy();
    const res = await runProbe({
      seat: { ...standInSeatWithPrice(adapter) },
      ledger: ledger(),
      items,
      allowances: ALLOWANCES,
      capUsd: "0.25",
    });
    expect(res.capReached).toBe(true);
    const wf = res.rows.filter((r) => r.condition === "working-field").length;
    const th = res.rows.filter((r) => r.condition === "thinking").length;
    expect(wf).toBe(th);
    expect(wf).toBeLessThan(items.length);
    expect(calls.length).toBe(res.rows.length);
    expect(Number(res.spentUsd)).toBeLessThanOrEqual(0.25);
    // a cap too small for even one call makes none
    const none = await runProbe({
      seat: { ...standInSeatWithPrice(adapter) },
      ledger: ledger(),
      items,
      allowances: ALLOWANCES,
      capUsd: "0.01",
    });
    expect(none.rows).toEqual([]);
    expect(none.capReached).toBe(true);
  });

  it("never runs a condition twice: what is already done is skipped, and a resumed run adds only the rest", async () => {
    const { adapter, calls } = spy();
    const only = instanceOf("CR-PL");
    const res = await runProbe({
      seat: { ...standInSeat("solver", { id: "claude-haiku-4-5" }), adapter },
      ledger: ledger(),
      items: [only, instanceOf("CR-SM")],
      allowances: ALLOWANCES,
      done: new Set([
        `working-field|${only.instance.id}`,
        `thinking|${only.instance.id}`,
        `working-field|${instanceOf("CR-SM").instance.id}`,
      ]),
    });
    expect(res.rows.map((r) => `${r.condition}|${r.record.instance}`)).toEqual([
      `thinking|${instanceOf("CR-SM").instance.id}`,
    ]);
    expect(calls).toHaveLength(1);
  });

  it("counts answers, passes, dollars and the first failure class of each", async () => {
    const { adapter } = spy();
    const res = await runProbe({
      seat: { ...standInSeat("solver", { id: "claude-haiku-4-5" }), adapter },
      ledger: ledger(),
      items: [instanceOf("CR-VS"), instanceOf("CR-SM")],
      allowances: ALLOWANCES,
    });
    const t = tally(
      "thinking",
      res.rows.filter((r) => r.condition === "thinking").map((r) => r.record),
    );
    expect(t).toMatchObject({ condition: "thinking", answers: 2, passed: 2, classes: {} });
    expect(Number(t.usd)).toBeGreaterThan(0);
  });
});

/** a seat priced like Haiku, so a few calls use up a small cap */
function standInSeatWithPrice(adapter: Adapter) {
  return {
    ...standInSeat("solver", {
      id: "claude-haiku-4-5",
      price: { priceInUsdPer1M: "10", priceOutUsdPer1M: "50" },
    }),
    adapter,
  };
}

describe("how the result is read, fixed before the run", () => {
  it("working space if both conditions pass at least half; capability if neither passes more than a sixth; otherwise partial", () => {
    expect(readResult(24, { workingField: 12, thinking: 15 })).toBe("working-space");
    expect(readResult(24, { workingField: 12, thinking: 11 })).toBe("partial");
    expect(readResult(24, { workingField: 4, thinking: 0 })).toBe("capability");
    expect(readResult(24, { workingField: 5, thinking: 0 })).toBe("partial");
    expect(readResult(24, { workingField: 24, thinking: 3 })).toBe("partial");
  });
});
