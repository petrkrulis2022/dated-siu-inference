import { describe, expect, it } from "vitest";
import { countPasses, rateBps, v3aIssuerPassTable } from "./v3a-pass-rates.js";

const rec = (part: string, model: string, task: string, passed: boolean): string =>
  JSON.stringify({ part, model, task, passed, raw_output: "never read" });

describe("v3a pass-rate export", () => {
  it("counts snapshot-mode answers only (snapshot and dry-run), never MCP sessions", () => {
    const c = countPasses([
      rec("snapshot", "m", "CR-PL", true),
      rec("dry-run", "m", "CR-PL", false),
      rec("mcp", "m", "CR-PL", true),
      "",
    ]);
    expect(c.m?.["CR-PL"]).toEqual({ answers: 2, passes: 1 });
  });

  it("gives C1/C2 haiku-5-5's measured rates, F sonnet-5's on all four types, and X D119's 80% floor as a rule, not a measured cell", () => {
    const lines: string[] = [];
    for (const t of ["CR-PL", "CR-UO", "CR-SM", "CR-VS"])
      for (let i = 0; i < 18; i++) {
        lines.push(rec("dry-run", "claude-haiku-5-5", t, i !== 0));
        lines.push(rec("dry-run", "claude-sonnet-5", t, i < 17));
      }
    const table = v3aIssuerPassTable(countPasses(lines));
    expect(table["ISSUER-C1"]?.["CR-PL"]?.bps).toBe(rateBps({ answers: 18, passes: 17 }));
    expect(table["ISSUER-C2"]).toEqual(table["ISSUER-C1"]);
    expect(Object.keys(table["ISSUER-F"] ?? {}).sort()).toEqual(["CR-PL", "CR-SM", "CR-UO", "CR-VS"]);
    expect(table["ISSUER-X"]?.["CR-UO"]).toEqual({
      bps: 8_000,
      source: { rule: "D119's qualifying floor (80%), pre-registered for ISSUER-X (owner, D143)" },
    });
    expect(table["ISSUER-X"]?.["CR-VS"]).toBeUndefined();
  });

  it("refuses to invent a rate the ledger has no answers for", () => {
    expect(() => v3aIssuerPassTable({})).toThrow(/no claude-haiku-5-5 answers on CR-PL/);
  });
});
