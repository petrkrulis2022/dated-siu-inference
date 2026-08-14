import { decimalLessThanOrEqual, relativeDelta } from "./decimal.js";

export interface ReconciliationRecord {
  print_id: string;
  computed_usd: string;
  invoice_usd: string;
  relative_delta: string;
  tolerance: string;
  status: "final" | "provisional";
  reconciled_at: string;
}

/** build1-spec.md §4: reconciled prints are marked final; unreconciled ones stay provisional. */
export const DEFAULT_RECONCILE_TOLERANCE = "0.02";

export function reconcile(
  printId: string,
  computedUsd: string,
  invoiceUsd: string,
  tolerance: string = DEFAULT_RECONCILE_TOLERANCE,
  now: string = new Date().toISOString(),
): ReconciliationRecord {
  const delta = relativeDelta(computedUsd, invoiceUsd);
  const status = decimalLessThanOrEqual(delta, tolerance) ? "final" : "provisional";

  return {
    print_id: printId,
    computed_usd: computedUsd,
    invoice_usd: invoiceUsd,
    relative_delta: delta,
    tolerance,
    status,
    reconciled_at: now,
  };
}

export function formatReconciliationReport(record: ReconciliationRecord): string {
  const deltaPct = (Number(record.relative_delta) * 100).toFixed(2);
  const lines = [
    `Print ${record.print_id}`,
    `  Computed from run records: $${record.computed_usd}`,
    `  Invoice figure supplied:   $${record.invoice_usd}`,
    `  Relative delta: ${deltaPct}% (tolerance: ${(Number(record.tolerance) * 100).toFixed(0)}%)`,
    `  Status: ${record.status.toUpperCase()}`,
  ];
  if (record.status === "provisional") {
    lines.push(
      "  Delta exceeds tolerance — not marked final. Re-check run records or supply a corrected invoice figure.",
    );
  }
  return lines.join("\n");
}
