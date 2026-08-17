import type { PriceSnapshot, Print } from "@datum/sdk";

type ExchangeRateRow = Print["exchange_rate_table"][number];
type PriceEntry = PriceSnapshot["entries"][number];

export interface GateFailure {
  print_id: string;
  model_id: string;
  reason: string;
}

export interface SubsidisedEntry {
  model_id: string;
  price_in_usd_per_1m: string;
  price_out_usd_per_1m: string;
}

export interface UnanchoredPrint {
  print_id: string;
  date: string;
  anchorStatus: string;
}

export interface StaleProvisionalPrint {
  print_id: string;
  date: string;
  daysSincePublished: number;
}

export interface HealthReport {
  latestPrint: { print_id: string; date: string } | null;
  gateFailuresInLatestPrint: GateFailure[];
  subsidisedModels: SubsidisedEntry[];
  priceSnapshotIsStale: boolean;
  priceSnapshotTimestamp: string | null;
  unanchoredPrints: UnanchoredPrint[];
  staleProvisionalPrints: StaleProvisionalPrint[];
  publisherEthBalanceWei: string;
}

const ANCHORED_STATUSES = new Set(["anchored", "already-anchored"]);
/** No specific deadline is stated anywhere in docs/methodology.md — one full weekly cadence
 * cycle (build1-spec.md §12's stated cadence) is the natural default for "past the
 * reconciliation window"; overridable per call. */
const DEFAULT_RECONCILIATION_WINDOW_DAYS = 7;

export interface ComputeHealthInput {
  prints: Print[];
  latestPriceSnapshot: PriceSnapshot | null;
  publisherEthBalanceWei: string;
  now?: Date;
  reconciliationWindowDays?: number;
}

/** Pure: every input is already-loaded data, no I/O here — the route handler does the loading
 * (loadAllPrints, a live getBalance, reading the latest snapshot file). */
export function computeHealthReport(input: ComputeHealthInput): HealthReport {
  const now = input.now ?? new Date();
  const windowDays = input.reconciliationWindowDays ?? DEFAULT_RECONCILIATION_WINDOW_DAYS;
  const latest = input.prints.at(-1) ?? null;

  const gateFailuresInLatestPrint: GateFailure[] = latest
    ? latest.exchange_rate_table
        .filter((row: ExchangeRateRow) => row.excluded_reason)
        .map((row: ExchangeRateRow) => ({
          print_id: latest.print_id,
          model_id: row.model_id,
          reason: row.excluded_reason!,
        }))
    : [];

  const subsidisedModels: SubsidisedEntry[] = (input.latestPriceSnapshot?.entries ?? [])
    .filter((e: PriceEntry) => e.subsidised)
    .map((e: PriceEntry) => ({
      model_id: e.model_id,
      price_in_usd_per_1m: e.price_in_usd_per_1m,
      price_out_usd_per_1m: e.price_out_usd_per_1m,
    }));

  const priceSnapshotTimestamp = input.latestPriceSnapshot?.timestamp ?? null;
  const priceSnapshotIsStale = Boolean(
    latest && priceSnapshotTimestamp && new Date(priceSnapshotTimestamp) < new Date(latest.date),
  );

  const unanchoredPrints: UnanchoredPrint[] = input.prints
    .filter((p) => !ANCHORED_STATUSES.has(p.anchor.status))
    .map((p) => ({ print_id: p.print_id, date: p.date, anchorStatus: p.anchor.status }));

  const staleProvisionalPrints: StaleProvisionalPrint[] = input.prints
    .filter((p) => p.status === "provisional")
    .map((p) => {
      const days = Math.floor((now.getTime() - new Date(p.date).getTime()) / (1000 * 60 * 60 * 24));
      return { print_id: p.print_id, date: p.date, daysSincePublished: days };
    })
    .filter((p) => p.daysSincePublished > windowDays);

  return {
    latestPrint: latest ? { print_id: latest.print_id, date: latest.date } : null,
    gateFailuresInLatestPrint,
    subsidisedModels,
    priceSnapshotIsStale,
    priceSnapshotTimestamp,
    unanchoredPrints,
    staleProvisionalPrints,
    publisherEthBalanceWei: input.publisherEthBalanceWei,
  };
}
