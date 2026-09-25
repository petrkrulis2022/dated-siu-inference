import { describe, expect, it } from "vitest";
import type { GateHardeningResult } from "@touchstone/task-pack-gate-hardening";
import { checkGateDeterminism } from "./determinism.js";

function passingResult(): GateHardeningResult {
  const pass = { passed: true, reason: "ok" };
  return { passed: true, g1: pass, g2: pass, g3: pass, g4: pass, g5: pass, g6: pass };
}

function failingResult(reason: string): GateHardeningResult {
  const pass = { passed: true, reason: "ok" };
  const fail = { passed: false, reason };
  return { passed: false, g1: pass, g2: pass, g3: pass, g4: pass, g5: fail, g6: pass };
}

describe("checkGateDeterminism", () => {
  it("reports deterministic when two real invocations agree", async () => {
    const result = await checkGateDeterminism(async () => passingResult());
    expect(result.deterministic).toBe(true);
  });

  it("reports non-deterministic when two real invocations disagree on the verdict", async () => {
    let call = 0;
    const result = await checkGateDeterminism(async () => (call++ === 0 ? passingResult() : failingResult("flaked")));
    expect(result.deterministic).toBe(false);
  });

  it("reports non-deterministic when the overall verdict matches but a per-check reason differs", async () => {
    let call = 0;
    const result = await checkGateDeterminism(async () =>
      call++ === 0 ? failingResult("first reason") : failingResult("second reason"),
    );
    expect(result.deterministic).toBe(false);
  });

  it("really calls the thunk twice, not once memoized", async () => {
    let calls = 0;
    await checkGateDeterminism(async () => {
      calls++;
      return passingResult();
    });
    expect(calls).toBe(2);
  });
});
