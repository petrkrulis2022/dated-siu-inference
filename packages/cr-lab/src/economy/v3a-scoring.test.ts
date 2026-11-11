/**
 * Phase 2 item 3 of the v3a build: every receipt-based measure filters by currency and is reported per currency; an empty sample reports n/a, never 0.0% (the code check's
 * finding 6b, docs/v2-code-check.md: v2's conversion, hops and circulation all scored the same six USDC receipts as if they were AGU-lab). Written before the fix and run
 * against the unfixed scorer first.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CR_PUBLIC_DIR, REPO_ROOT } from "../paths.js";
import type { LogEntry } from "./log.js";
import { loadParams } from "./params.js";
import { onwardSpends } from "./report.js";
import {
  renderScoringReport,
  scoreBuyingAhead,
  scoreCirculation,
  scoreComparability,
  scoreConversionToUsdc,
  scoreHops,
  scoreIssuerExits,
  scoreQuotingInDollars,
  scoreRun,
} from "./scoring.js";

const params = loadParams(join(CR_PUBLIC_DIR, "economy-params.v2.json"));

let seq = 0;
const entry = (window: string, round: number, actor: string, rest: Partial<LogEntry>): LogEntry =>
  ({ seq: ++seq, window, round, actor, backend: "stand-in", kind: "notice", ...rest }) as LogEntry;
const roundTrip = (log: readonly LogEntry[]): LogEntry[] =>
  log.map(
    (e) =>
      JSON.parse(
        JSON.stringify(e, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
      ) as LogEntry,
  );

/** v2's own shape: a brief paid to a research agent in USDC, which it then spends onward in AGU-lab; no model agent ever receives AGU-lab */
const usdcOnly = (): LogEntry[] => [
  entry("2026-11-03", 0, "DEMAND-1", {
    kind: "escrow-open",
    escrow: "e1",
    quote: "q1",
    to: "RESEARCH-1",
    usdc: 1_500n,
  }),
  entry("2026-11-03", 1, "GATE-RUNNER", {
    kind: "escrow-settle",
    escrow: "e1",
    paid: 1_500n,
    refunded: 0n,
  }),
  entry("2026-11-03", 2, "RESEARCH-1", {
    kind: "escrow-open",
    escrow: "e2",
    to: "ISSUER-C1",
    agu: 300n,
  }),
  entry("2026-11-04", 0, "x", { kind: "notice" }),
];

/** one AGU-lab receipt spent onward in AGU-lab, one USDC receipt followed only by an AGU-lab payment (not an onward USDC spend) */
const mixed = (): LogEntry[] => [
  entry("2026-11-03", 0, "DEMAND-1", {
    kind: "escrow-open",
    escrow: "a1",
    quote: "q1",
    to: "RESEARCH-1",
    agu: 1_000n,
  }),
  entry("2026-11-03", 1, "GATE-RUNNER", {
    kind: "escrow-settle",
    escrow: "a1",
    paid: 1_000n,
    refunded: 0n,
  }),
  entry("2026-11-03", 2, "RESEARCH-1", {
    kind: "escrow-open",
    escrow: "a2",
    to: "ISSUER-C1",
    agu: 500n,
  }),
  entry("2026-11-03", 3, "DEMAND-2", {
    kind: "escrow-open",
    escrow: "u1",
    quote: "q2",
    to: "RESEARCH-2",
    usdc: 2_000n,
  }),
  entry("2026-11-03", 4, "GATE-RUNNER", {
    kind: "escrow-settle",
    escrow: "u1",
    paid: 2_000n,
    refunded: 0n,
  }),
  entry("2026-11-03", 5, "RESEARCH-2", {
    kind: "escrow-open",
    escrow: "a3",
    to: "ISSUER-C1",
    agu: 400n,
  }),
  entry("2026-11-04", 0, "x", { kind: "notice" }),
];

describe("Phase 2 item 3: receipts are filtered and reported per currency; an empty sample is n/a", () => {
  it("an all-USDC sample (v2's shape) gives every AGU-lab receipt measure n/a, and neither AGU-lab kill criterion fires", () => {
    const r = scoreRun(usdcOnly(), params, new Map());
    expect(r.circulation.agu).toEqual({
      onwardSpends: 0,
      opportunities: 0,
      share: null,
      holds: null,
    });
    expect(r.killCriteria.conversionOnReceipt.agu.share).toBeNull();
    expect(r.killCriteria.conversionOnReceipt.agu.fails).toBe(false);
    expect(r.killCriteria.medianHops.agu.median).toBeNull();
    expect(r.killCriteria.medianHops.agu.fails).toBe(false);
    // the USDC receipt is still counted -- as USDC
    expect(r.circulation.usdc.opportunities).toBe(1);
  });

  it("a receipt counts as spent onward only by a later payment in the same currency", () => {
    expect(scoreCirculation(mixed(), params, "agu")).toEqual({
      onwardSpends: 1,
      opportunities: 1,
      share: 1,
      holds: true,
    });
    expect(scoreCirculation(mixed(), params, "usdc")).toEqual({
      onwardSpends: 0,
      opportunities: 1,
      share: 0,
      holds: false,
    });
    expect(scoreHops(mixed(), params, "agu").values).toEqual([2]);
    expect(scoreHops(mixed(), params, "usdc").values).toEqual([1]);
    expect(scoreCirculation(roundTrip(mixed()), params, "agu")).toEqual(
      scoreCirculation(mixed(), params, "agu"),
    );
  });

  it("conversion to USDC applies to AGU-lab receipts; for USDC receipts it is n/a by definition, never 0%", () => {
    const usdc = scoreConversionToUsdc(mixed(), params, new Map(), "usdc");
    expect(usdc.share).toBeNull();
    expect(usdc.fails).toBe(false);
    expect(scoreConversionToUsdc(mixed(), params, new Map(), "agu").opportunities).toBe(1);
  });

  it("the dev-window 'AGU-lab circulated' check counts only AGU-lab receipts spent onward in AGU-lab, live or read back from disk", () => {
    expect(onwardSpends(usdcOnly(), "agu")).toBe(0);
    expect(onwardSpends(mixed(), "agu")).toBe(1);
    expect(onwardSpends(roundTrip(mixed()), "agu")).toBe(1);
  });

  it("an issuer's AGU-lab income sale traces only the AGU-lab payments into it, never a USDC commission", () => {
    const log: LogEntry[] = [
      entry("2026-11-03", 0, "DEMAND-1", {
        kind: "escrow-open",
        escrow: "c1",
        to: "ISSUER-C1",
        usdc: 300n,
      }),
      entry("2026-11-03", 1, "GATE-RUNNER", {
        kind: "escrow-settle",
        escrow: "c1",
        paid: 300n,
        refunded: 0n,
      }),
      entry("2026-11-03", 2, "RESEARCH-1", {
        kind: "escrow-open",
        escrow: "c2",
        to: "ISSUER-C1",
        agu: 1_000n,
      }),
      entry("2026-11-03", 3, "GATE-RUNNER", {
        kind: "escrow-settle",
        escrow: "c2",
        paid: 1_000n,
        refunded: 0n,
      }),
      entry("2026-11-03", 9, "PARTICIPANT", {
        kind: "participant-buyback",
        from: "ISSUER-C1",
        agu: 1_000n,
        usdc: 13n,
        issuerCode: true,
      }),
    ];
    expect(scoreIssuerExits(log)[0]?.payers).toEqual([
      { agent: "RESEARCH-1", agu: 1_000n, hops: 1 },
    ]);
  });

  it("buying ahead, quoting and comparability each report their own per-currency split", () => {
    const log: LogEntry[] = [
      entry("2026-11-03", 0, "DEMAND-1", {
        kind: "message",
        to: "AGU-ISSUER",
        text: "front-claim order: 0.250 SIU of CR-PL for the next window",
        pay: "agu",
      }),
      entry("2026-11-03", 1, "HEDGER", {
        kind: "claim-mint",
        task: "CR-UO",
        forWindow: 2,
        payUnit: "usdc",
      }),
      entry("2026-11-03", 2, "RESEARCH-1", {
        kind: "quote",
        quote: "q1",
        need: "n1",
        priceMicroSiu: 100_000n,
        priceUnit: "siu",
      }),
      entry("2026-11-03", 2, "RESEARCH-2", {
        kind: "quote",
        quote: "q2",
        need: "n1",
        priceMicroSiu: 200_000n,
        priceUnit: "usdc",
        priceUsdcMicro: 280n,
      }),
      entry("2026-11-03", 3, "DEMAND-1", {
        kind: "claim-transfer",
        tokenId: "t1",
        from: "DEMAND-1",
        to: "RESEARCH-1",
        milli: 100n,
        quote: "q1",
      }),
      entry("2026-11-03", 4, "GATE-RUNNER", {
        kind: "gate",
        brief: "q1",
        passed: true,
        components: [],
      }),
      entry("2026-11-04", 0, "x", { kind: "notice" }),
    ];
    expect(scoreBuyingAhead(log, params).actionsByUnit).toEqual({ agu: 1, usdc: 1, unrecorded: 0 });
    expect(scoreQuotingInDollars(log, params).bindingQuotesByUnit).toEqual({ siu: 1, usdc: 1 });
    // a quote paid in work claims is an acceptance like any other: it enters comparability's sample, labelled by how it was paid
    const c = scoreComparability(log);
    expect(c.siuFirstSample).toBe(1);
    expect(c.acceptedPaidIn).toEqual({ agu: 0, usdc: 0, claims: 1 });
  });

  it("renders both currencies for every receipt measure, and an empty sample as n/a with its count -- never 0.0%", () => {
    const text = renderScoringReport(scoreRun(usdcOnly(), params, new Map()));
    expect(text).toMatch(/- AGU-lab: n\/a \(0 receipts\)/);
    expect(text).toMatch(/- USDC: 0 of 1 receipts spent onward in USDC \(0\.0%\)/);
    expect(text).toMatch(
      /1\. near-universal conversion to USDC on receipt.*AGU-lab: n\/a \(0 receipts\).*USDC: n\/a \(a USDC receipt is already USDC\).*does not fire/,
    );
    expect(text).toMatch(
      /2\. median hops stays at one.*AGU-lab: n\/a \(0 receipts\).*USDC: 1 \(1 receipts\).*does not fire/,
    );
    expect(text).toMatch(/3\. quoting in dollars when free to choose.*n\/a \(no messages\)/);
  });
});

describe("Phase 2 item 8: a diagnostic re-score is headed as one, and never overwrites a scoring file", () => {
  const score = (args: string[]) =>
    spawnSync(
      join(REPO_ROOT, "node_modules", ".bin", "tsx"),
      [join(REPO_ROOT, "packages", "cr-lab", "src", "cli", "economy-score.ts"), ...args],
      { encoding: "utf-8", cwd: REPO_ROOT },
    );
  const fixture = (): { dir: string; log: string } => {
    const dir = mkdtempSync(join(tmpdir(), "rescore-"));
    const log = join(dir, "log.jsonl");
    writeFileSync(
      log,
      `${usdcOnly()
        .map((e) =>
          JSON.stringify(e, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
        )
        .join("\n")}\n`,
    );
    return { dir, log };
  };
  const V2_PATH = join(CR_PUBLIC_DIR, "economy-params.v2.json");

  it("--diagnostic writes a new file whose first line says it is a diagnostic, not the pre-registered verdict", () => {
    const { dir, log } = fixture();
    const out = join(dir, "scoring-diagnostic.md");
    const r = score(["--log", log, "--params", V2_PATH, "--diagnostic", "--out", out]);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(out, "utf-8");
    expect(text.split("\n")[0]).toBe(
      "# Diagnostic re-score with corrected code. Not the pre-registered verdict.",
    );
    expect(text).toContain("## Pre-registered scoring");
  }, 60_000);

  it("refuses to overwrite an existing output file, so a recorded scoring.md can never be replaced", () => {
    const { dir, log } = fixture();
    const out = join(dir, "scoring.md");
    writeFileSync(out, "the recorded verdict\n");
    const r = score(["--log", log, "--params", V2_PATH, "--out", out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/already exists/);
    expect(readFileSync(out, "utf-8")).toBe("the recorded verdict\n");
  }, 60_000);
});
