import type { D1Database } from "@cloudflare/workers-types";

/**
 * The settlement log — mainnet-switch brief decision 4: a separate D1 database (`touchstone-settlements`,
 * never the print repo) recording every paid call. No new public endpoint reads it. Amounts are kept
 * as the atomic-unit decimal STRING the payment carried, never a float (CLAUDE.md invariant 4).
 *
 * `reference` is whatever identifies the settlement at its route: the Gateway transfer id for a
 * batched Nanopayment (the on-chain batch transaction is only known later, at reconciliation, so
 * `batch_tx` starts empty), or the on-chain transaction hash for a payment this server settled itself.
 */
export type SettlementRoute = "gateway-batched" | "self-settled";

export interface SettlementEntry {
  tool: string;
  network: string;
  route: SettlementRoute;
  /** atomic units of the paid token, as a decimal string */
  amount: string;
  payer: string;
  reference: string;
  /** ISO-8601 */
  at: string;
}

export const SETTLEMENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  network TEXT NOT NULL,
  route TEXT NOT NULL,
  amount TEXT NOT NULL,
  payer TEXT NOT NULL,
  reference TEXT NOT NULL,
  batch_tx TEXT
);
CREATE INDEX IF NOT EXISTS settlements_at ON settlements (at);
CREATE INDEX IF NOT EXISTS settlements_reference ON settlements (reference);`;

/** The route a payment took, from the network it was made on. */
export function routeFor(network: string, selfSettledNetworks: readonly string[]): SettlementRoute {
  return selfSettledNetworks.includes(network) ? "self-settled" : "gateway-batched";
}

/**
 * Appends one row. Never throws: like usage analytics, the log must not be able to break a paid
 * call that already settled. A write failure is reported through `onError` (the Worker logs it).
 */
export async function logSettlement(
  db: Pick<D1Database, "prepare"> | undefined,
  entry: SettlementEntry,
  onError: (err: unknown) => void = () => undefined,
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        "INSERT INTO settlements (at, tool, network, route, amount, payer, reference) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      )
      .bind(
        entry.at,
        entry.tool,
        entry.network,
        entry.route,
        entry.amount,
        entry.payer,
        entry.reference,
      )
      .run();
  } catch (err) {
    onError(err);
  }
}
