/**
 * What a scripted run has to have shown, checked from the run's own recorded events.
 *
 * A green run of a script proves only that the script's calls returned. These are the things the
 * walk exists to establish, each stated as a property of the events and computed here with its own
 * arithmetic — decimal strings to integers and back, written separately from `loop/parity.ts` and
 * `chain/` so that a defect in the code under test cannot also be in the reference it is held to
 * (spec §4.6ai: a fixture built from the code's own assumption cannot see the defect).
 *
 * The inputs are the events the loop recorded from the tools' own results — mint costs read from
 * receipt transfer logs, outcomes decoded from the settlement receipt — so a check here compares one
 * real fact with another, not the loop's belief with itself.
 *
 * Nothing here decides whether a run counts. A scripted run never does (`debug-mode.ts`).
 */
import type { ReportEvent, ReportMoment } from "./block-report.js";
import type { F1Report } from "./instrument-report.js";
import type { ScriptStatus } from "./scripted-policy.js";

export interface WalkEvent extends ReportEvent {
  quantityMilliSiu?: string;
  counterparty?: string;
  issuer?: string;
}

export interface WalkMoment extends ReportMoment {
  quotedUsdMax?: string;
}

export interface WalkWindow {
  windowIndex: number;
  capacityEvents: WalkEvent[];
  paymentMoments: WalkMoment[];
  usdcSettlements?: { requestId: string; settledMinorUnits: string; quotedMinorUnits: string }[];
  /** For each settlement this window, whether its settler read the outcome in its next prompt. */
  settlementCopy?: { agentId: string; turn: number; tokenId?: string; outcome?: string; shownToSettler: boolean | null }[];
  /** Tool calls that errored this window, as the loop recorded them. Absent on a report that
   *  predates the field — which the walk then states, rather than treating as none. */
  toolErrors?: { agentId: string; turn: number; tool: string; error: string }[];
}

export interface WalkReport {
  rateUsdPerSiu: string;
  f1?: F1Report;
  windows: WalkWindow[];
}

export interface WalkCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** `"0.0144"` -> 14400n (USDC minor units). Exact: a figure with more places than USDC has is refused. */
export function usdToMinorUnits(usd: string): bigint {
  return decimalToInteger(usd, 6);
}

/** `"0.001437"` -> 1437000n (nano-USD per SIU). */
export function usdToNano(usd: string): bigint {
  return decimalToInteger(usd, 9);
}

function decimalToInteger(value: string, places: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`not a non-negative decimal: ${JSON.stringify(value)}`);
  const fraction = m[2] ?? "";
  if (fraction.length > places) {
    throw new Error(`${JSON.stringify(value)} has more than ${places} decimal places`);
  }
  return BigInt(m[1] + fraction.padEnd(places, "0"));
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** The claim that is worth `usdMinorUnits` at `nano`: ceil(minor × 10^6 / nano) mSIU. */
export function claimMilliSiuWorth(usdMinorUnits: bigint, nano: bigint): bigint {
  return ceilDiv(usdMinorUnits * 1_000_000n, nano);
}

/** What the contract charges to mint `milliSiu` at `nano`: floor(mSIU × nano / 10^6) minor units. */
export function mintCostOf(milliSiu: bigint, nano: bigint): bigint {
  return (milliSiu * nano) / 1_000_000n;
}

const MINTS = new Set(["pay_with_claim", "mint_claim", "settle_split"]);

const check = (name: string, ok: boolean, detail: string): WalkCheck => ({ name, ok, detail });

export function verifyWalk(report: WalkReport, status: readonly ScriptStatus[]): {
  ok: boolean;
  checks: WalkCheck[];
} {
  const nano = usdToNano(report.rateUsdPerSiu);
  const win = (n: number): WalkWindow | undefined => report.windows.find((w) => w.windowIndex === n);
  const events = (n: number): WalkEvent[] => win(n)?.capacityEvents ?? [];
  const allEvents = report.windows.flatMap((w) => w.capacityEvents);
  const moments = report.windows.flatMap((w) => w.paymentMoments);
  const checks: WalkCheck[] = [];

  // 1. Every scripted step was issued.
  const unperformed = status.filter((s) => !s.performed);
  checks.push(
    check(
      "every scripted step was issued",
      unperformed.length === 0,
      unperformed.length === 0
        ? `${status.length} of ${status.length}`
        : `not issued: ${unperformed.map((s) => `${s.seat} w${s.window} ${s.step}`).join("; ")}`,
    ),
  );

  // 2. No tool call errored.
  const recorded = report.windows.every((w) => w.toolErrors !== undefined);
  const errors = report.windows.flatMap((w) => (w.toolErrors ?? []).map((e) => ({ ...e, window: w.windowIndex })));
  checks.push(
    check(
      "no tool call errored",
      recorded && errors.length === 0,
      !recorded
        ? "the report does not record tool errors, so none can be ruled out"
        : errors.length === 0
          ? "none"
          : errors.map((e) => `w${e.window} ${e.agentId} turn ${e.turn} ${e.tool}: ${e.error}`).join("; "),
    ),
  );

  // 3. Parity: every claim that settles a quote is worth the quote's dollar price at the print.
  const parityProblems: string[] = [];
  let parityChecked = 0;
  for (const e of allEvents) {
    const settles = e.settlesRequestId;
    if (settles === undefined || e.quantityMilliSiu === undefined) continue;
    if (!["pay_with_claim", "transfer_claim"].includes(e.kind)) continue;
    const moment = moments.find((m) => m.requestId === settles && m.tool === e.kind);
    if (moment?.quotedUsdMax === undefined) {
      parityProblems.push(`${e.kind} for ${settles}: no recorded quote price to hold it to`);
      continue;
    }
    parityChecked += 1;
    const expected = claimMilliSiuWorth(usdToMinorUnits(moment.quotedUsdMax), nano);
    if (BigInt(e.quantityMilliSiu) !== expected) {
      parityProblems.push(`${e.kind} for ${settles}: ${e.quantityMilliSiu} mSIU, expected ${expected}`);
    }
  }
  checks.push(
    check(
      "claim sizes equal ceil(quote price / print)",
      parityChecked > 0 && parityProblems.length === 0,
      parityChecked === 0 ? "no claim payment to check" : parityProblems.length === 0 ? `${parityChecked} payments` : parityProblems.join("; "),
    ),
  );

  // 4. Mint cost: what the minter actually paid is quantity × print.
  const costProblems: string[] = [];
  const mints = allEvents.filter((e) => MINTS.has(e.kind));
  for (const e of mints) {
    if (e.mintCostMinorUnits === undefined || e.quantityMilliSiu === undefined) {
      costProblems.push(`${e.kind} ${e.tokenId ?? "?"}: no mint cost recorded`);
      continue;
    }
    const expected = mintCostOf(BigInt(e.quantityMilliSiu), nano);
    if (BigInt(e.mintCostMinorUnits) !== expected) {
      costProblems.push(`${e.kind} ${e.tokenId}: paid ${e.mintCostMinorUnits}, expected ${expected}`);
    }
  }
  checks.push(
    check(
      "mint costs equal quantity × print, from the receipt's own transfer",
      mints.length > 0 && costProblems.length === 0,
      mints.length === 0 ? "no mint to check" : costProblems.length === 0 ? `${mints.length} mints` : costProblems.join("; "),
    ),
  );

  // 5. Window 1 is single-issuer, and window 2 routes elsewhere once the first is drained.
  const w1Issuers = new Set(events(1).filter((e) => MINTS.has(e.kind)).map((e) => e.issuer?.toLowerCase()));
  const w2Issuers = new Set(events(2).filter((e) => MINTS.has(e.kind)).map((e) => e.issuer?.toLowerCase()));
  checks.push(
    check(
      "window 1 is backed by one issuer and window 2 by another",
      w1Issuers.size === 1 && w2Issuers.size === 1 && ![...w2Issuers].some((i) => w1Issuers.has(i)),
      `window 1: ${[...w1Issuers].join(",") || "no mint"}; window 2: ${[...w2Issuers].join(",") || "no mint"}`,
    ),
  );

  // 6. Onward in part, then the remainder is redeemed and served at exactly the remainder.
  const mint1 = events(1).find((e) => MINTS.has(e.kind));
  const onward = events(1).find((e) => e.kind === "transfer_claim" && e.settlesRequestId !== undefined);
  const served = events(1).find((e) => e.kind === "serve_redemption");
  const presented = events(1).find((e) => e.kind === "redeem_claim");
  const partialOk =
    mint1?.quantityMilliSiu !== undefined &&
    onward?.quantityMilliSiu !== undefined &&
    BigInt(onward.quantityMilliSiu) > 0n &&
    BigInt(onward.quantityMilliSiu) < BigInt(mint1.quantityMilliSiu);
  checks.push(
    check(
      "a part of a held claim paid onward, and less than the whole",
      partialOk,
      partialOk
        ? `minted ${mint1!.quantityMilliSiu}, passed on ${onward!.quantityMilliSiu}`
        : "no keyed transfer of part of the window-1 claim was recorded",
    ),
  );
  const remainder = partialOk ? BigInt(mint1!.quantityMilliSiu!) - BigInt(onward!.quantityMilliSiu!) : undefined;
  checks.push(
    check(
      "the remainder was presented, and served at exactly the remainder",
      presented !== undefined &&
        served?.quantityMilliSiu !== undefined &&
        remainder !== undefined &&
        BigInt(served.quantityMilliSiu) === remainder,
      served?.quantityMilliSiu === undefined
        ? `${presented === undefined ? "never presented" : "presented"}; no serve_redemption was recorded`
        : `served ${served.quantityMilliSiu} against a remainder of ${remainder ?? "unknown"}`,
    ),
  );

  // 7. The bond pays a Default at the print; an unpresented claim pays nobody.
  const settlements = allEvents.filter((e) => e.kind === "settle_window_close");
  const defaulted = settlements.find((e) => e.settlementOutcome === "Defaulted");
  const expired = settlements.find((e) => e.settlementOutcome === "Expired");
  const mintOf = (tokenId: string | undefined): WalkEvent | undefined =>
    allEvents.find((e) => MINTS.has(e.kind) && e.tokenId === tokenId);
  const wasSplit = (tokenId: string | undefined): boolean =>
    allEvents.some((e) => e.kind === "transfer_claim" && e.tokenId === tokenId);
  let defaultOk = defaulted !== undefined && defaulted.bondPaidMinorUnits !== undefined;
  let defaultDetail = defaulted === undefined ? "no Defaulted settlement was recorded" : "";
  if (defaulted !== undefined && defaultOk) {
    const minted = mintOf(defaulted.tokenId);
    if (minted?.quantityMilliSiu === undefined || wasSplit(defaulted.tokenId)) {
      defaultDetail = `bond paid ${defaulted.bondPaidMinorUnits}; not independently checkable (the claim was passed on in part)`;
      defaultOk = true;
    } else {
      const expectedPay = mintCostOf(BigInt(minted.quantityMilliSiu), nano);
      defaultOk = BigInt(defaulted.bondPaidMinorUnits!) === expectedPay;
      defaultDetail = `bond paid ${defaulted.bondPaidMinorUnits}, expected ${expectedPay}`;
    }
  } else if (defaulted !== undefined) {
    defaultDetail = "the Defaulted settlement recorded no bond payment";
  }
  checks.push(check("the bond paid a Default the claim's value at the print", defaultOk, defaultDetail));
  checks.push(
    check(
      "an unpresented claim expired and paid nobody",
      expired !== undefined && (expired.bondPaidMinorUnits === undefined || BigInt(expired.bondPaidMinorUnits) === 0n),
      expired === undefined ? "no Expired settlement was recorded" : `bond paid ${expired.bondPaidMinorUnits ?? "none"}`,
    ),
  );

  // 8. Every event carries the facts a report is built from.
  const bare: string[] = [];
  for (const e of allEvents) {
    if (e.kind === "pay_with_claim" && (e.mintCostMinorUnits === undefined || e.settlesRequestId === undefined)) {
      bare.push(`pay_with_claim ${e.tokenId}`);
    }
    if (e.kind === "settle_window_close" && e.settlementOutcome === undefined) bare.push(`settle_window_close ${e.tokenId}`);
    if (e.kind === "transfer_claim" && e.settlesRequestId !== undefined && e.quantityMilliSiu === undefined) {
      bare.push(`transfer_claim ${e.tokenId}`);
    }
  }
  checks.push(check("every event carries its settled quote, mint cost and outcome", bare.length === 0, bare.length === 0 ? "yes" : `missing on: ${bare.join("; ")}`));

  // 8b. What a settler is TOLD. A settlement's consequence differs by a fact the settler may not
  // know, so what it reads afterwards is part of the instrument; this reads it from the recorded
  // prompt, not from the tool's result.
  const copyRecorded = report.windows.every((w) => w.settlementCopy !== undefined);
  const copyRows = report.windows.flatMap((w) => (w.settlementCopy ?? []).map((r) => ({ ...r, window: w.windowIndex })));
  const unshown = copyRows.filter((r) => r.shownToSettler !== true);
  checks.push(
    check(
      "every settler was shown what its settlement did",
      copyRecorded && copyRows.length > 0 && unshown.length === 0,
      !copyRecorded
        ? "the report does not record what settlers were shown"
        : copyRows.length === 0
          ? "no settlement was recorded"
          : unshown.length === 0
            ? `${copyRows.length} settlements`
            : unshown
                .map((r) => `w${r.window} ${r.agentId} turn ${r.turn} (${r.outcome ?? "outcome not decoded"}): ${r.shownToSettler === null ? "no later turn or no outcome to look for" : "next prompt does not say"}`)
                .join("; "),
    ),
  );

  // 9. The decision rule, computed over these events by the report's own code.
  const f1 = report.f1;
  const code = f1?.opportunities["WORKER-CODE"];
  const orch = f1?.opportunities["ORCHESTRATOR"];
  const ruleOk =
    f1?.reached === true &&
    code?.eligible === true &&
    code.spentOnward === true &&
    orch?.eligible !== true &&
    f1.countingErrors.length === 0;
  checks.push(
    check(
      "the decision rule marks WORKER-CODE eligible and onward, ORCHESTRATOR never eligible, and counts cleanly",
      ruleOk,
      f1 === undefined
        ? "the report has no f1 block"
        : `WORKER-CODE eligible=${code?.eligible} onward=${code?.spentOnward}; ORCHESTRATOR eligible=${orch?.eligible}; counting errors: ${f1.countingErrors.length}`,
    ),
  );

  // 10. The dollar route ran as a control in windows 2 and 3.
  const usdc = (n: number): number => win(n)?.usdcSettlements?.length ?? 0;
  checks.push(
    check(
      "the dollar route settled quotes in windows 2 and 3",
      usdc(2) > 0 && usdc(3) > 0,
      `window 2: ${usdc(2)}; window 3: ${usdc(3)}`,
    ),
  );

  return { ok: checks.every((c) => c.ok), checks };
}

export function renderWalk(result: { ok: boolean; checks: readonly WalkCheck[] }): string {
  return [
    `SCRIPTED WALK — ${result.ok ? "ALL CHECKS PASSED" : "CHECKS FAILED"}`,
    ...result.checks.map((c) => `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}\n        ${c.detail}`),
  ].join("\n");
}
