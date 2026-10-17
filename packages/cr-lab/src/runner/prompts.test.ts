import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { TASKS, drawInstances, type Instance } from "../tasks/instances.js";
import { gradeAnswer } from "./grade.js";
import { buildPrompt, referenceAnswerJson } from "./prompts.js";
import { solverFromPrompt } from "./stand-in-models.js";

let f: FixtureDay;
let instances: Instance[];
beforeAll(async () => {
  f = await fixtureDay();
  instances = drawInstances(f.day, "b".repeat(64));
});
afterAll(() => f.cleanup());

describe("snapshot-mode prompts", () => {
  it("builds a prompt for every instance the day draws, for all four tasks", () => {
    expect(new Set(instances.map((i) => i.task))).toEqual(new Set(TASKS));
    for (const i of instances) expect(buildPrompt(i, f.day), i.id).toBeDefined();
  });

  it("is a pure function of the instance and the data: the same bytes, the same hashes", () => {
    for (const i of instances) {
      const a = buildPrompt(i, f.day);
      const b = buildPrompt(i, f.day);
      expect(a?.text).toBe(b?.text);
      expect(a?.promptSha256).toBe(b?.promptSha256);
      expect(a?.dataSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a?.dataSha256).not.toBe(a?.promptSha256);
    }
  });

  it("carries enough to answer: a solver that sees only the prompt text gets an answer the gate passes, for every instance", () => {
    for (const i of instances) {
      const prompt = buildPrompt(i, f.day);
      const answer = JSON.stringify(solverFromPrompt(prompt?.text ?? ""));
      const verdict = gradeAnswer(i, answer);
      expect(verdict.failures, `${i.id}: ${JSON.stringify(verdict.failures)}`).toEqual([]);
      expect(verdict.passed).toBe(true);
    }
  });

  it("never contains the reference answer: no figure of the key appears in the prompt", () => {
    for (const i of instances) {
      const text = buildPrompt(i, f.day)?.text ?? "";
      const key = referenceAnswerJson(i);
      const figures = key.match(/-?\d+\.\d{6}/g) ?? [];
      expect(figures.length, `${i.id} has a key to check`).toBeGreaterThan(0);
      for (const fig of figures)
        expect(text.includes(fig), `${i.id} shows key figure ${fig}`).toBe(false);
      expect(text.toLowerCase()).not.toContain("reference");
    }
  });

  it("states the answer schema and the plain-decimal rule in every prompt", () => {
    for (const i of instances) {
      const text = buildPrompt(i, f.day)?.text ?? "";
      expect(text).toContain("Answer schema:");
      expect(text).toContain("no exponent, no units, no thousands separators");
      expect(text).toContain("Reply with the JSON object only.");
    }
  });

  it("keeps the input small: the largest fixture prompt stays under a rough 20,000 tokens", () => {
    for (const i of instances)
      expect(buildPrompt(i, f.day)?.approxTokens ?? 0).toBeLessThan(20_000);
  });

  it("returns undefined, not a guess, when the day cannot supply an instance", () => {
    const vs = instances.find((i) => i.task === "CR-PL") as Extract<Instance, { task: "CR-PL" }>;
    const gone = { ...f.day, lending: new Map() };
    expect(buildPrompt(vs, gone)).toBeUndefined();
  });
});
