import type { Provider } from "../keys.js";

/** What a call was spent on, so the daily table can split the trial by part (§16.7). */
export type Part =
  "snapshot" | "mcp" | "economy" | "issuer" | "mirror" | "smoke" | "dry-run" | "other";
export const PARTS: readonly Part[] = [
  "snapshot",
  "mcp",
  "economy",
  "issuer",
  "mirror",
  "smoke",
  "dry-run",
  "other",
];

/** One recorded spend. Carries no Blockworks data: a provider, an amount, a model, and the NAME of the key used (never its value). */
export interface SpendEntry {
  /** ISO 8601, UTC. */
  at: string;
  provider: Provider;
  /** Decimal USD, from the provider's usage report at the provider's prices. */
  usd: string;
  part: Part;
  model: string;
  /** The `.env` variable name of the key that paid, for the daily reconciliation against each provider's per-key usage. */
  key: string;
  what: string;
}

/** What a provider may spend on the trial: the budget, and the moment it was set (spend before it is already inside the balance). */
export interface ProviderBudget {
  budgetUsd: string;
  since: string;
}

export interface SpendPolicy {
  /** The trial's cap for one UTC day, across providers (D73: $9). */
  dailyCapUsd: string;
  /** A provider with no entry has no budget, and spending on it is refused. */
  providers: Partial<Record<Provider, ProviderBudget>>;
}

/** A call that has been allowed but not yet settled: it counts against the caps until it is. */
export interface Pending {
  provider: Provider;
  usd: string;
}
