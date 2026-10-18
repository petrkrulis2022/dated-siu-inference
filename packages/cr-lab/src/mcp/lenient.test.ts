import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { referenceAnswerJson } from "../runner/prompts.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance } from "../tasks/instances.js";
import { FakeMcp } from "./fake-mcp.js";
import { dayFromRelayed, gradeMcpAnswer, lastJsonObject } from "./relayed.js";
import { readPlan } from "./stand-in-agent.js";

describe("the last JSON object in a reply (a diagnostic, never counted)", () => {
  it("finds the object after prose, inside a fence, and the last of two", () => {
    expect(lastJsonObject('Let me work it out first.\n\n{"a": 1}')).toBe('{"a": 1}');
    expect(lastJsonObject('Here:\n```json\n{"a": {"b": [1, 2]}}\n```\nDone.')).toBe(
      '{"a": {"b": [1, 2]}}',
    );
    expect(lastJsonObject('draft {"a": 1} final {"a": 2}')).toBe('{"a": 2}');
  });

  it("is not fooled by braces inside strings or text, and finds nothing where there is nothing", () => {
    expect(lastJsonObject('{"note": "a } and a { inside", "n": 3}')).toBe(
      '{"note": "a } and a { inside", "n": 3}',
    );
    expect(lastJsonObject("no object here, just {braces and words}")).toBeUndefined();
    expect(lastJsonObject("")).toBeUndefined();
    expect(lastJsonObject("[1, 2, 3]")).toBeUndefined();
  });
});

describe("a failed answer that was only a failure of format", () => {
  let f: FixtureDay;
  let pl: Extract<Instance, { task: "CR-PL" }>;
  beforeAll(async () => {
    f = await fixtureDay();
    pl = drawInstances(f.day, "8".repeat(64)).find((i) => i.task === "CR-PL") as typeof pl;
  });
  afterAll(() => f.cleanup());

  async function relayed() {
    const m = new FakeMcp({ backend: f.backend, today: f.day.window });
    const calls = [];
    for (const [tool, args] of readPlan(pl, f.day))
      calls.push({ tool, args, ...(await m.call(tool, args)) });
    return dayFromRelayed(f.day.window, calls);
  }

  it("is counted as failed, and the diagnostic says the data and the figures were right", async () => {
    const text = `Now I'll add it all up.\n\n- fees: the sum...\n\n${referenceAnswerJson(pl)}`;
    const g = gradeMcpAnswer({ instance: pl, text, relayed: await relayed() });
    expect(g.passed).toBe(false);
    expect(g.classification.primary).toBe("schema");
    expect(g.lenientPassed).toBe(true);
  });

  it("the diagnostic is false when the figures are wrong too, and absent when the strict reading passed or the failure was not format", async () => {
    const wrong = JSON.stringify({ ...JSON.parse(referenceAnswerJson(pl)), fees: "1" });
    const bad = gradeMcpAnswer({
      instance: pl,
      text: `thinking...\n${wrong}`,
      relayed: await relayed(),
    });
    expect(bad.passed).toBe(false);
    expect(bad.lenientPassed).toBe(false);
    const good = gradeMcpAnswer({
      instance: pl,
      text: referenceAnswerJson(pl),
      relayed: await relayed(),
    });
    expect(good.passed).toBe(true);
    expect(good.lenientPassed).toBeUndefined();
    const notFormat = gradeMcpAnswer({ instance: pl, text: wrong, relayed: await relayed() });
    expect(notFormat.lenientPassed).toBeUndefined();
  });
});
