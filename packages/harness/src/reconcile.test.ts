import { describe, expect, it } from "vitest";
import { reconcile } from "./reconcile.js";

describe("reconcile", () => {
  it("marks the print final when computed cost is within tolerance of the invoice", () => {
    const record = reconcile("2026-08-14", "100.00", "101.00", "0.02", "2026-08-14T00:00:00Z");
    expect(record.status).toBe("final");
    expect(Number(record.relative_delta)).toBeCloseTo(0.0099, 4);
  });

  it("marks the print provisional when computed cost exceeds tolerance", () => {
    const record = reconcile("2026-08-14", "100.00", "150.00", "0.02", "2026-08-14T00:00:00Z");
    expect(record.status).toBe("provisional");
  });

  it("marks final on an exact match", () => {
    const record = reconcile("2026-08-14", "100.00", "100.00");
    expect(record.status).toBe("final");
    expect(record.relative_delta).toBe("0");
  });

  it("marks final right at the tolerance boundary (<=, not <)", () => {
    const record = reconcile("2026-08-14", "102.00", "100.00", "0.02");
    expect(record.relative_delta).toBe("0.02");
    expect(record.status).toBe("final");
  });

  it("uses the default tolerance when none is supplied", () => {
    const record = reconcile("2026-08-14", "101.00", "100.00");
    expect(record.tolerance).toBe("0.02");
  });

  it("records the print id, both figures, and the timestamp supplied", () => {
    const record = reconcile("print-xyz", "50.00", "50.00", "0.02", "2026-08-14T12:00:00Z");
    expect(record.print_id).toBe("print-xyz");
    expect(record.computed_usd).toBe("50.00");
    expect(record.invoice_usd).toBe("50.00");
    expect(record.reconciled_at).toBe("2026-08-14T12:00:00Z");
  });
});
