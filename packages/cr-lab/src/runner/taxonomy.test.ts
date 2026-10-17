import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { D } from "@touchstone/sdk";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance, type TaskId } from "../tasks/instances.js";
import { gradeAnswer } from "./grade.js";
import { referenceAnswerJson } from "./prompts.js";
import { PRIORITY, classify, isPowerOfTenSlip } from "./taxonomy.js";

let f: FixtureDay;
let by: Record<TaskId, Instance>;
beforeAll(async () => {
  f = await fixtureDay();
  const all = drawInstances(f.day, "c".repeat(64));
  by = Object.fromEntries(
    ["CR-VS", "CR-PL", "CR-UO", "CR-SM"].map((t) => [t, all.find((i) => i.task === t)]),
  ) as Record<TaskId, Instance>;
});
afterAll(() => f.cleanup());

const answer = (t: TaskId): Record<string, unknown> => JSON.parse(referenceAnswerJson(by[t]));
const classOf = (t: TaskId, reply: unknown, extra: { stopReason?: string } = {}) => {
  const text = typeof reply === "string" ? reply : JSON.stringify(reply);
  const verdict = text.trim() === "" ? undefined : gradeAnswer(by[t], text);
  return classify({
    instance: by[t],
    text,
    ...(verdict !== undefined ? { verdict } : {}),
    ...extra,
  });
};

describe("the failure taxonomy", () => {
  it("a correct answer has no class", () => {
    for (const t of ["CR-VS", "CR-PL", "CR-UO", "CR-SM"] as const)
      expect(classOf(t, answer(t))).toEqual({ classes: [] });
  });

  it("schema: a reply that is not the JSON object, or has the wrong keys", () => {
    expect(classOf("CR-UO", "The answer is about 3 percent.").primary).toBe("schema");
    expect(classOf("CR-UO", { unlock30: "1", unlock90: "2" }).primary).toBe("schema");
    expect(classOf("CR-PL", { fees: "not a number", payouts: "1", revenue: "1" }).primary).toBe(
      "schema",
    );
  });

  it("missing-items: the right shape, short of items", () => {
    const sm = answer("CR-SM") as { top5: unknown[] };
    expect(classOf("CR-SM", { top5: sm.top5.slice(0, 4) }).primary).toBe("missing-items");
    const vs = answer("CR-VS") as { venues: string[] };
    expect(classOf("CR-VS", { ...vs, venues: vs.venues.slice(0, 4) }).primary).toBe(
      "missing-items",
    );
    expect(classOf("CR-UO", { unlock30_pct: "1" }).primary).toBe("missing-items");
  });

  it("wrong-entity: the wrong venue or id was chosen", () => {
    const sm = answer("CR-SM") as { top5: { id: string; change_usd: string }[] };
    const wrong = sm.top5.map((r, i) => (i === 4 ? { ...r, id: "fixture-not-a-real-id" } : r));
    expect(classOf("CR-SM", { top5: wrong }).primary).toBe("wrong-entity");
    const vs = answer("CR-VS") as {
      venues: string[];
      shares: Record<string, Record<string, string>>;
    };
    const venues = [...vs.venues.slice(0, 4), "fixture-venue-nobody-ranked"];
    const shares = Object.fromEntries(
      Object.entries(vs.shares).map(([m, row]) => [
        m,
        Object.fromEntries(venues.map((v, i) => [v, Object.values(row)[i] as string])),
      ]),
    );
    expect(classOf("CR-VS", { venues, shares }).classes).toContain("wrong-entity");
  });

  it("ordering: the right five in the wrong order", () => {
    const sm = answer("CR-SM") as { top5: unknown[] };
    const top = [...sm.top5];
    [top[0], top[1]] = [top[1], top[0]];
    expect(classOf("CR-SM", { top5: top }).primary).toBe("ordering");
  });

  it("scale-slip: the right digits, the wrong power of ten", () => {
    const uo = answer("CR-UO") as { unlock30_pct: string; unlock90_pct: string };
    expect(
      classOf("CR-UO", { ...uo, unlock30_pct: new D(uo.unlock30_pct).times(100).toFixed() })
        .primary,
    ).toBe("scale-slip");
    expect(
      classOf("CR-UO", { ...uo, unlock90_pct: new D(uo.unlock90_pct).div(10).toFixed() }).primary,
    ).toBe("scale-slip");
  });

  it("arithmetic: a figure off by something other than a power of ten, or an answer that contradicts itself", () => {
    const uo = answer("CR-UO") as { unlock30_pct: string; unlock90_pct: string };
    expect(
      classOf("CR-UO", { ...uo, unlock30_pct: new D(uo.unlock30_pct).plus("0.05").toFixed() })
        .primary,
    ).toBe("arithmetic");
    const pl = answer("CR-PL") as { fees: string; payouts: string; revenue: string };
    const payouts = new D(pl.payouts).times("1.03");
    expect(
      classOf("CR-PL", { fees: pl.fees, payouts: payouts.toFixed(), revenue: pl.revenue }).primary,
    ).toBe("arithmetic");
  });

  it("call-failed, truncated and no-output come before anything graded", () => {
    expect(
      classify({ instance: by["CR-UO"], text: "", callError: "AdapterHttpError HTTP 429" }).primary,
    ).toBe("call-failed");
    expect(classOf("CR-UO", "", { stopReason: "max_tokens" })).toMatchObject({
      primary: "truncated",
      classes: ["truncated", "no-output"],
    });
    expect(classOf("CR-UO", "").primary).toBe("no-output");
    expect(classOf("CR-UO", '{"unlock30_pct": 1', { stopReason: "max_tokens" }).primary).toBe(
      "truncated",
    );
  });

  it("a reply that ended at the length limit but is correct is not truncated", () => {
    expect(classOf("CR-UO", answer("CR-UO"), { stopReason: "max_tokens" })).toEqual({
      classes: [],
    });
  });

  it("unclassified: a failed verdict that no rule explains is kept for review, never dropped", () => {
    const r = classify({
      instance: by["CR-UO"],
      text: "{}",
      verdict: { passed: false, failures: [], fenced: false },
    });
    expect(r.primary).toBe("unclassified");
  });

  it("every class lists in priority order, primary first", () => {
    const r = classOf("CR-UO", "", { stopReason: "max_tokens" });
    expect(r.classes).toEqual(PRIORITY.filter((c) => r.classes.includes(c)));
    expect(r.primary).toBe(r.classes[0]);
  });
});

describe("the power-of-ten rule", () => {
  const d = (s: string) => new D(s);
  it("sees decimal-point slips in both directions and ignores ordinary errors", () => {
    expect(isPowerOfTenSlip(d("12.34"), d("1.234"))).toBe(true);
    expect(isPowerOfTenSlip(d("0.1234"), d("12.34"))).toBe(true);
    expect(isPowerOfTenSlip(d("1234000"), d("1.234"))).toBe(true);
    expect(isPowerOfTenSlip(d("12.34"), d("12.5"))).toBe(false);
    expect(isPowerOfTenSlip(d("12.34"), d("12.34"))).toBe(false);
  });
  it("never calls a zero or a sign flip a slip", () => {
    expect(isPowerOfTenSlip(d("0"), d("10"))).toBe(false);
    expect(isPowerOfTenSlip(d("10"), d("0"))).toBe(false);
    expect(isPowerOfTenSlip(d("-12.34"), d("1.234"))).toBe(false);
  });
});
