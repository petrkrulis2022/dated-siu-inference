import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances } from "../tasks/instances.js";
import { gradeAnswer } from "./grade.js";
import { buildPrompt } from "./prompts.js";
import { standInAdapter } from "./stand-in-models.js";

let f: FixtureDay;
beforeAll(async () => {
  f = await fixtureDay();
});
afterAll(() => f.cleanup());

const params = { temperature: 0, max_tokens: 100 };

describe("the stand-in models, for any seed", () => {
  it("the solver passes and the sloppy stand-in FAILS every instance that twenty-five different seeds draw", async () => {
    const solver = standInAdapter("solver");
    const sloppy = standInAdapter("sloppy");
    let checked = 0;
    for (let n = 0; n < 25; n++) {
      const seed = createHash("sha256").update(`seed-${n}`).digest("hex");
      for (const inst of drawInstances(f.day, seed)) {
        const prompt = buildPrompt(inst, f.day)!.text;
        const good = await solver("m", prompt, params);
        const bad = await sloppy("m", prompt, params);
        expect(gradeAnswer(inst, good.text).passed, `${inst.id} seed ${n}: solver`).toBe(true);
        expect(
          gradeAnswer(inst, bad.text).passed,
          `${inst.id} seed ${n}: sloppy damage did not bite`,
        ).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  }, 60_000);
});
