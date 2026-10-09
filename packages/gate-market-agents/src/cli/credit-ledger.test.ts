import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertCreditGuard, loadSpendLedger, recordSpend } from "./credit-ledger.js";

describe("the spend ledger and the guard that reads it (D60)", () => {
  let dir: string;
  let path: string;
  const saved = process.env.LAB_CYCLE_CAP_USD;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ledger-"));
    path = join(dir, "ledger.json");
    delete process.env.LAB_CYCLE_CAP_USD;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.LAB_CYCLE_CAP_USD;
    else process.env.LAB_CYCLE_CAP_USD = saved;
  });
  const now = new Date("2026-10-09T12:00:00Z");

  it("starts empty when there is no file, and keeps what it is given", () => {
    expect(loadSpendLedger(path).entries).toEqual([]);
    recordSpend({ at: "2026-10-09T10:00:00Z", usd: "0.5", what: "a run" }, path);
    recordSpend({ at: "2026-10-09T11:00:00Z", usd: "0.25", what: "a probe" }, path);
    expect(loadSpendLedger(path).entries.map((e) => e.usd)).toEqual(["0.5", "0.25"]);
    expect(readFileSync(path, "utf-8").endsWith("\n")).toBe(true);
  });

  it("allows a spend under the cap, naming what is left, and refuses one over it with the guard's own sentence", () => {
    recordSpend({ at: "2026-10-09T10:00:00Z", usd: "29", what: "earlier" }, path);
    expect(assertCreditGuard("0.5", now, path)).toBe("0.500000");
    expect(() => assertCreditGuard("1.5", now, path)).toThrow(/CREDIT GUARD: the lab and its probes have spent \$29\.000000 of the \$30\.00 cap/);
  });

  it("takes the cap from LAB_CYCLE_CAP_USD when it is set", () => {
    process.env.LAB_CYCLE_CAP_USD = "2";
    recordSpend({ at: "2026-10-09T10:00:00Z", usd: "1.9", what: "earlier" }, path);
    expect(() => assertCreditGuard("0.5", now, path)).toThrow(/\$2\.00 cap/);
  });

  it("does not count last cycle's spend", () => {
    recordSpend({ at: "2026-09-20T10:00:00Z", usd: "29.9", what: "last cycle" }, path);
    expect(() => assertCreditGuard("5", now, path)).toThrow(); // still the same cycle: it started on 2026-09-18
    expect(assertCreditGuard("5", new Date("2026-10-18T10:00:00Z"), path)).toBe("25.000000"); // renewed
  });
});
