import type { Print, PriceSnapshot, RunRecord } from "@touchstone/sdk";
import { D, computeClassCost, printBodyHashHex, type TaskClass } from "@touchstone/print";

type ExchangeRateRow = Print["exchange_rate_table"][number];
type PriceEntry = PriceSnapshot["entries"][number];

export interface GetQuoteInput {
  task_class: string;
  model: string;
}

export interface GetQuoteOutput {
  siu_per_call: string;
  usd_per_siu: string;
  index_version: string;
  print_id: string;
  print_hash: string;
}

const TASK_CLASSES = new Set<string>(["T1", "T2", "T3"]);

/**
 * get_quote(task_class, model) — build1-spec.md §9: "SIU price, exchange rate, index refs."
 *
 * `Print.exchange_rate_table`/`basket_costs` are whole-basket aggregates; there is no published
 * per-class figure. `siu_per_call` is derived, not invented: `@touchstone/print`'s `computeClassCost`
 * — the same function that builds the print itself — run fresh against the print's own
 * referenced run records for this (task_class, model), divided by the model's own published
 * `usd_per_siu` (one call's cost as a fraction of one whole SIU basket).
 *
 * Takes already-loaded `print`, `snapshot`, and every run record for `input.model` (server.ts
 * loads them from `data/`, including the empty-directory case) — this function is pure
 * computation, testable without a filesystem. `data/runs/<print_id>/` is empty until a real
 * harness run has executed, so an empty `modelRunRecords` throws an honest "no run records"
 * error rather than fabricate a number — the same gap already flagged after P7/P9, not new here.
 */
export function getQuoteTool(
  input: GetQuoteInput,
  print: Print,
  snapshot: PriceSnapshot,
  modelRunRecords: RunRecord[],
): GetQuoteOutput {
  if (!TASK_CLASSES.has(input.task_class)) {
    throw new Error(`Unknown task_class "${input.task_class}". Expected one of T1, T2, T3.`);
  }

  const row = print.exchange_rate_table.find((r: ExchangeRateRow) => r.model_id === input.model);
  if (!row || row.usd_per_siu === undefined) {
    throw new Error(
      `Model "${input.model}" has no published exchange rate in print ${print.print_id}` +
        (row?.excluded_reason ? ` (${row.excluded_reason}).` : "."),
    );
  }

  const priceEntry = snapshot.entries.find((e: PriceEntry) => e.model_id === input.model);
  if (!priceEntry) {
    throw new Error(
      `Model "${input.model}" has no price in the snapshot print ${print.print_id} referenced (${print.price_snapshot_ref}).`,
    );
  }

  const classRecords = modelRunRecords.filter(
    (r) => r.task_class === (input.task_class as TaskClass),
  );

  const classCost = computeClassCost(classRecords, {
    price_in_usd_per_1m: priceEntry.price_in_usd_per_1m,
    price_out_usd_per_1m: priceEntry.price_out_usd_per_1m,
  });

  if (classCost.cost === undefined) {
    throw new Error(
      `No priced ${input.task_class} run records for "${input.model}" against print ` +
        `${print.print_id}: ${classCost.undefinedReason ?? "no run records"}.`,
    );
  }

  const siuPerCall = classCost.cost.dividedBy(new D(row.usd_per_siu));

  return {
    siu_per_call: siuPerCall.toString(),
    usd_per_siu: row.usd_per_siu,
    index_version: print.version,
    print_id: print.print_id,
    print_hash: printBodyHashHex(print),
  };
}
