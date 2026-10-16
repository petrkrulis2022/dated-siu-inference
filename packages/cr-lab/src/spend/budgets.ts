/**
 * The trial's budgets, from `data/lab/cr/budgets.json` (D72, §16.11). Each provider's trial budget is **the balance read from its console, minus 30 days of the print's
 * own measured spend there**, so what the trial may spend can never touch what the print needs. The file records the print's reserve per provider and each balance with
 * the moment it was read; a provider with no recorded balance has no budget and the ledger refuses to spend on it (it fails closed). Updating a balance after a top-up
 * is how a budget is raised, and spend before the balance's `asOf` is already inside it and is not counted again.
 */
import { D } from "@touchstone/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS, type Provider } from "../keys.js";
import { CR_PUBLIC_DIR } from "../paths.js";
import { fmtUsd, parseUsd } from "./money.js";
import type { SpendPolicy } from "./types.js";

export const BUDGETS_PATH = join(CR_PUBLIC_DIR, "budgets.json");

export interface BudgetsFile {
  note?: string;
  /** The trial's cap per UTC day (D73). */
  dailyCapUsd: string;
  /** 30 days of the print's measured spend, per provider. */
  printReserveUsd: Partial<Record<Provider, string>>;
  /** A balance as read from the provider's console, and when. */
  balances: Partial<Record<Provider, { usd: string; asOf: string; source?: string }>>;
}

export function parseBudgets(value: unknown): BudgetsFile {
  const f = value as BudgetsFile;
  parseUsd(f?.dailyCapUsd, "dailyCapUsd");
  for (const p of Object.keys(f.printReserveUsd ?? {})) {
    if (!PROVIDERS.includes(p as Provider))
      throw new TypeError(`printReserveUsd: unknown provider ${p}`);
    parseUsd(f.printReserveUsd[p as Provider], `printReserveUsd.${p}`);
  }
  for (const [p, b] of Object.entries(f.balances ?? {})) {
    if (!PROVIDERS.includes(p as Provider)) throw new TypeError(`balances: unknown provider ${p}`);
    parseUsd(b.usd, `balances.${p}.usd`);
    if (Number.isNaN(new Date(b.asOf).getTime()))
      throw new TypeError(`balances.${p}.asOf is not a date: ${b.asOf}`);
  }
  return { ...f, printReserveUsd: f.printReserveUsd ?? {}, balances: f.balances ?? {} };
}

export function loadBudgets(path: string = BUDGETS_PATH): BudgetsFile {
  return parseBudgets(JSON.parse(readFileSync(path, "utf-8")));
}

/**
 * The spend policy the ledger enforces. A provider's budget is its balance minus the print's reserve there, floored at zero (a provider already below its reserve gets no
 * budget to spend, and says so); a provider with no balance, or no recorded reserve, gets none.
 */
export function policyFromBudgets(file: BudgetsFile): SpendPolicy {
  const providers: SpendPolicy["providers"] = {};
  for (const p of PROVIDERS) {
    const balance = file.balances[p];
    const reserve = file.printReserveUsd[p];
    if (balance === undefined || reserve === undefined) continue;
    const left = new D(balance.usd).minus(reserve);
    providers[p] = { budgetUsd: fmtUsd(left.lessThan(0) ? new D(0) : left), since: balance.asOf };
  }
  return { dailyCapUsd: file.dailyCapUsd, providers };
}
