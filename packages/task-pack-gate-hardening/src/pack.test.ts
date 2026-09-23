import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNoNetworkImports } from "@touchstone/task-pack-sdk";
import { CODE_GATE_HARDENING_PACK, EXTRACT_GATE_HARDENING_PACK } from "./pack.js";

// Real sandboxed executions throughout — no mocks, matching this package's own established
// discipline (executor.test.ts, gate/tasks/*.test.ts).
describe.each([
  ["code", CODE_GATE_HARDENING_PACK],
  ["extract", EXTRACT_GATE_HARDENING_PACK],
] as const)("%s gate-hardening TaskPack", (_label, pack) => {
  it("accepts the known-good hardened gate", async () => {
    const result = await pack.gate(pack.fixtures.knownGood, pack.fixtures.reference);
    expect(result.accept).toBe(true);
  }, 30_000);

  it("rejects the pack-level adversarial (weak candidate) gate", async () => {
    const result = await pack.gate(pack.fixtures.adversarial[0], pack.fixtures.reference);
    expect(result.accept).toBe(false);
    expect(result.reason.length).toBeGreaterThan(0);
  }, 30_000);

  it("declares WORKER-CODE and WORKER-EXTRACT as its roles", () => {
    expect(pack.roles).toEqual(["WORKER-CODE", "WORKER-EXTRACT"]);
  });

  it("declares a non-empty work unit and metrics list", () => {
    expect(pack.workUnit.length).toBeGreaterThan(0);
    expect(pack.metrics.length).toBeGreaterThan(0);
  });
});

describe("pack.ts's own gate-exporting module", () => {
  it("imports no network/client library (spec §14.2 rule 3)", () => {
    const path = fileURLToPath(new URL("./pack.ts", import.meta.url));
    const source = readFileSync(path, "utf-8");
    expect(() => assertNoNetworkImports(source, path)).not.toThrow();
  });
});
