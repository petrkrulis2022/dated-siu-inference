import { describe, expect, it } from "vitest";
import type { LogEntry } from "./log.js";
import { renderStepPage } from "./step-page.js";

let seq = 0;
const e = (actor: string, kind: string, rest: Partial<LogEntry> = {}): LogEntry => ({
  seq: ++seq,
  window: "2026-11-07",
  round: 0,
  actor,
  backend: "stand-in",
  kind: kind as LogEntry["kind"],
  ...rest,
});

describe("renderStepPage", () => {
  it("pairs an agent's own reasoning entry with the turn that follows it, and includes the provider's summary when present", () => {
    const log: LogEntry[] = [
      e("HEDGER", "reasoning", { text: "delivering on time keeps the bonus", providerSummary: "thinking: schedule says one is due" }),
      e("HEDGER", "turn", { tool: "deliver_forward", parsed: true }),
      e("GATE-RUNNER", "receipt", { forwardBrief: 1, of: 2 }),
    ];
    const page = renderStepPage(log, "HEDGER");
    expect(page).toContain("delivering on time keeps the bonus");
    expect(page).toContain("thinking: schedule says one is due");
    expect(page).toContain("tool: deliver_forward");
  });

  it("includes a settlement entry addressed to the agent even though its own actor is GATE-RUNNER, via the escrow's own 'to'", () => {
    const log: LogEntry[] = [
      e("DEMAND-1", "escrow-open", { escrow: "e1", to: "RESEARCH-1", agu: 1_000n }),
      e("GATE-RUNNER", "escrow-settle", { escrow: "e1", paid: 1_000n, refunded: 0n }),
    ];
    const page = renderStepPage(log, "RESEARCH-1");
    expect(page).toContain("escrow settled");
    expect(page).not.toContain("paid into escrow"); // that line belongs to DEMAND-1, not RESEARCH-1
  });

  it("never shows another agent's own reasoning or unrelated turns", () => {
    const log: LogEntry[] = [
      e("RESEARCH-2", "reasoning", { text: "a secret only RESEARCH-2 should show" }),
      e("RESEARCH-2", "turn", { tool: "pass" }),
    ];
    const page = renderStepPage(log, "RESEARCH-1");
    expect(page).not.toContain("a secret only RESEARCH-2 should show");
  });

  it("renders a hedger's objective log entry's own numbers directly, no reconstruction needed", () => {
    const log: LogEntry[] = [e("HEDGER", "objective", { onTimeThisWindow: 1, lateThisWindow: 0, owedByNow: 1, deliveredByNow: 1 })];
    const page = renderStepPage(log, "HEDGER");
    expect(page).toContain("1 on time, 0 late");
  });

  it("renders the real refusal reason for an 'error' entry, not just the bare word 'error' (found generating the dev-test's own example page)", () => {
    const log: LogEntry[] = [e("RESEARCH-1", "error", { tool: "commission_task", refused: "BelowMinSettlement" })];
    const page = renderStepPage(log, "RESEARCH-1");
    expect(page).toContain("refused: commission_task -- BelowMinSettlement");
  });
});
