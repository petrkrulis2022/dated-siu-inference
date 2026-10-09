/**
 * The file side of the credit guard (`lab/credit-guard.ts`, D60): a ledger of the Anthropic spend of the lab and its probes, and the check that stops a
 * run or a probe before it would take the credit the daily print needs. The ledger is `data/lab/anthropic-spend-ledger.json`, tracked in git so the spend
 * is visible beside the runs it paid for. The cap is `LAB_CYCLE_CAP_USD` if set, else $30.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkCreditGuard, withSpend, type SpendEntry } from "../lab/credit-guard.js";
import { REPO_ROOT } from "./p5-shared.js";

export const SPEND_LEDGER_PATH = join(REPO_ROOT, "data/lab/anthropic-spend-ledger.json");

interface LedgerFile {
  note?: string;
  entries: SpendEntry[];
}

export function loadSpendLedger(path: string = SPEND_LEDGER_PATH): LedgerFile {
  if (!existsSync(path)) return { entries: [] };
  return JSON.parse(readFileSync(path, "utf-8")) as LedgerFile;
}

export function recordSpend(entry: SpendEntry, path: string = SPEND_LEDGER_PATH): void {
  const file = loadSpendLedger(path);
  writeFileSync(path, `${JSON.stringify({ ...file, entries: withSpend(file.entries, entry) }, null, 2)}\n`);
}

/** Refuses, by throwing, when `projectedUsd` more would take the cycle's lab and probe spend past the cap. Returns what is left under the cap. */
export function assertCreditGuard(projectedUsd: string, now: Date = new Date(), path: string = SPEND_LEDGER_PATH): string {
  const check = checkCreditGuard({
    entries: loadSpendLedger(path).entries,
    now,
    projectedUsd,
    ...(process.env.LAB_CYCLE_CAP_USD !== undefined && process.env.LAB_CYCLE_CAP_USD !== "" ? { capUsd: process.env.LAB_CYCLE_CAP_USD } : {}),
  });
  if (!check.ok) throw new Error(`CREDIT GUARD: ${check.reason}`);
  return check.remainingUnderCap;
}
