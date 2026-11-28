import { MAINNET_PAYMENT_NETWORKS } from "@touchstone/print";
import { KITE_MAINNET, KITE_TESTNET } from "./self-settled.js";

/**
 * The payment log as bookkeeping CSV: mainnet-switch brief decision 4 ("a daily CSV export by
 * script to gitignored data/private/; no new public endpoint"), approved 2026-11-27. One file per
 * complete UTC day, read from the settlement log's `settlements_classified` view (the log plus the
 * payer's traffic class, workers/wallet-labels.ts). Amounts are converted from the atomic units
 * the payment carried by exact string arithmetic, never a float (CLAUDE.md invariant 4).
 *
 * `batch_tx` stays empty until reconciliation is built: Gateway settles Nanopayments in batches and
 * nothing yet looks up which batch carried which payment.
 */

/** One row of the `settlements_classified` view. */
export interface ClassifiedSettlementRow {
  id: number;
  at: string;
  tool: string;
  network: string;
  route: string;
  /** atomic units, as a decimal string */
  amount: string;
  payer: string;
  reference: string;
  batch_tx: string | null;
  traffic: string;
}

export interface NetworkFacts {
  chain: string;
  mainnet: boolean;
  /** The token the payment was made in, as a bookkeeper would name it. */
  asset: string;
  decimals: number;
}

const USDC_DECIMALS = 6;

/**
 * Every network the server has ever taken payment on, with the decimals its payments carry. A row on
 * a network missing here is refused rather than converted with guessed decimals; the test keeps this
 * in step with every profile in networks.ts.
 */
export const PAYMENT_NETWORK_FACTS: ReadonlyMap<string, NetworkFacts> = new Map<string, NetworkFacts>([
  ...MAINNET_PAYMENT_NETWORKS.map(
    (n): [string, NetworkFacts] => [n.caip2, { chain: n.name, mainnet: true, asset: n.asset, decimals: USDC_DECIMALS }],
  ),
  ["eip155:84532", { chain: "Base Sepolia", mainnet: false, asset: "USDC", decimals: USDC_DECIMALS }],
  ["eip155:5042002", { chain: "Arc Testnet", mainnet: false, asset: "USDC", decimals: USDC_DECIMALS }],
  [KITE_TESTNET.network, { chain: KITE_TESTNET.name, mainnet: false, asset: "PYUSD", decimals: KITE_TESTNET.decimals }],
  [KITE_MAINNET.network, { chain: KITE_MAINNET.name, mainnet: true, asset: "USDC.e", decimals: KITE_MAINNET.decimals }],
]);

export const CSV_HEADER = [
  "id",
  "at",
  "tool",
  "chain",
  "network",
  "mainnet",
  "route",
  "asset",
  "amount",
  "amount_atomic",
  "payer",
  "traffic",
  "reference",
  "batch_tx",
] as const;

/** "1000" at 6 decimals -> "0.001000". Every decimal place is kept, so columns line up exactly. */
export function atomicToDecimal(atomic: string, decimals: number): string {
  if (!/^(0|[1-9]\d*)$/.test(atomic)) throw new Error(`not a whole number of atomic units: ${JSON.stringify(atomic)}`);
  if (decimals === 0) return atomic;
  const padded = atomic.padStart(decimals + 1, "0");
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}

/**
 * One CSV field (RFC 4180). A text field starting with =, +, - or @ gets a leading apostrophe, so a
 * spreadsheet shows it rather than evaluating it: payer and reference come from outside.
 */
export function csvField(value: string | number | null): string {
  if (value === null) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC calendar day ("2026-11-26") of an ISO-8601 UTC timestamp. */
export function utcDay(at: string): string {
  if (!ISO_UTC.test(at) || Number.isNaN(Date.parse(at))) throw new Error(`not an ISO-8601 UTC timestamp: ${JSON.stringify(at)}`);
  return at.slice(0, 10);
}

function assertDay(day: string): void {
  if (!DAY.test(day) || new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day)
    throw new Error(`not a day in YYYY-MM-DD form: ${JSON.stringify(day)}`);
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function toCsv(rows: readonly ClassifiedSettlementRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of rows) {
    const facts = PAYMENT_NETWORK_FACTS.get(r.network);
    if (!facts) throw new Error(`payment ${r.id} is on ${r.network}, a network the export does not know; refusing to guess its decimals`);
    lines.push(
      [
        r.id,
        r.at,
        r.tool,
        facts.chain,
        r.network,
        facts.mainnet ? "yes" : "no",
        r.route,
        facts.asset,
        atomicToDecimal(r.amount, facts.decimals),
        r.amount,
        r.payer,
        r.traffic,
        r.reference,
        r.batch_tx,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export interface DaysToExportInput {
  /** The UTC day of the first payment in the log; undefined while the log is empty. */
  firstDay: string | undefined;
  /** Today, UTC. Never exported: it is not over. */
  today: string;
  existingDays: ReadonlySet<string>;
  /** Days to write again although a file exists. */
  forceDays?: readonly string[];
}

/** Every complete UTC day from the first payment to yesterday with no file yet, plus forced days. */
export function daysToExport({ firstDay, today, existingDays, forceDays = [] }: DaysToExportInput): string[] {
  assertDay(today);
  const days = new Set<string>();
  for (const d of forceDays) {
    assertDay(d);
    if (d >= today) throw new Error(`${d} is not over yet (today is ${today} UTC); only complete days are exported`);
    days.add(d);
  }
  if (firstDay !== undefined) {
    assertDay(firstDay);
    for (let d = firstDay; d < today; d = nextDay(d)) if (!existingDays.has(d)) days.add(d);
  }
  return [...days].sort();
}

export interface ExportDeps extends Omit<DaysToExportInput, "firstDay"> {
  firstDay: () => Promise<string | undefined>;
  /** Rows with `at` in [fromDay 00:00, toDayExclusive 00:00) UTC. */
  query: (fromDay: string, toDayExclusive: string) => Promise<ClassifiedSettlementRow[]>;
  write: (day: string, csv: string) => Promise<void>;
}

export interface ExportResult {
  days: string[];
  rows: number;
  byTraffic: Record<string, number>;
}

/**
 * Writes one file per day to export, from one query over their span. Every file is built before the
 * first is written, so a row that cannot be converted leaves no day half-exported.
 */
export async function exportPayments(deps: ExportDeps): Promise<ExportResult> {
  const days = daysToExport({ ...deps, firstDay: await deps.firstDay() });
  if (days.length === 0) return { days, rows: 0, byTraffic: {} };
  const wanted = new Set(days);
  const rows = await deps.query(days[0]!, nextDay(days.at(-1)!));
  const byDay = new Map(days.map((d) => [d, [] as ClassifiedSettlementRow[]]));
  const byTraffic: Record<string, number> = {};
  let count = 0;
  for (const r of rows) {
    const day = utcDay(r.at);
    if (!wanted.has(day)) continue;
    byDay.get(day)!.push(r);
    byTraffic[r.traffic] = (byTraffic[r.traffic] ?? 0) + 1;
    count++;
  }
  const files = days.map((d) => [d, toCsv(byDay.get(d)!)] as const);
  for (const [day, csv] of files) await deps.write(day, csv);
  return { days, rows: count, byTraffic };
}
