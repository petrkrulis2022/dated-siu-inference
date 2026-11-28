/**
 * Whose payments are traction. Touchstone's own wallets paying the paid tools (the test buyer, the
 * demo and lab agents) are "internal"; wallets funded by Touchstone's own allowances or bounties
 * once the agent campaign starts are "campaign": real agents, but not organic demand, so they are
 * reported separately, never dropped. Everything else is "organic".
 *
 * The label always comes from the PAYING wallet, never the payee: the treasury receives every
 * payment, so excluding on it would exclude all revenue. The settlement log records the buyer's own
 * address for Gateway payments (checked on the 2026-11-26 mainnet calls), lowercased, and the
 * checksummed address for self-settled ones, so every comparison here is case-insensitive.
 *
 * This list is the one source: walletLabelsSyncSql() copies it into D1's wallet_labels table, which
 * the settlements_classified view reads for ad-hoc queries. Rule: any new wallet Touchstone controls
 * goes on this list before its first use. Foundry's public test account is deliberately absent:
 * anyone holds its key.
 */

export type WalletLabel = "internal" | "campaign";
export type TrafficClass = WalletLabel | "organic";

export interface LabelledWallet {
  address: string;
  label: WalletLabel;
  note: string;
  /** The date the wallet went on this list. */
  since: string;
}

/**
 * The treasury: payTo on every network since 2026-11-26. A dedicated hot wallet in MetaMask, used for
 * nothing else, until it holds more than $100 in total; then it moves to a hardware wallet (owner's
 * decision, 2026-11-28; src/treasury/treasury-total.ts raises the alert).
 */
export const TREASURY_ADDRESS = "0xB514882859f43DbF3df664C899D707f649E0CF4A";

export const WALLET_LABELS: readonly LabelledWallet[] = [
  {
    address: "0x22e2F3427FfBf5d453649824C7bfCB6c8F12d743",
    label: "internal",
    note: "test buyer (MCP_BUYER): mainnet and testnet payment tests",
    since: "2026-11-26",
  },
  {
    address: TREASURY_ADDRESS,
    label: "internal",
    note: "treasury, payTo on every network since 2026-11-26; a dedicated hot wallet in MetaMask until it holds over $100",
    since: "2026-11-26",
  },
  {
    address: "0x470571461B28C371E2D38766505E572350f43B75",
    label: "internal",
    note: "previous treasury (October testnet payments)",
    since: "2026-11-26",
  },
  {
    address: "0xD7CA8219C8AfA07b455Ab7e004FC5381B3727B1e",
    label: "internal",
    note: "testnet deployer, escrow fee treasury, old seller and demo buyer",
    since: "2026-11-26",
  },
  {
    address: "0x284ff2F8605Ff8AFeDa6959B856Bb7E6d48f845a",
    label: "internal",
    note: "print publisher",
    since: "2026-11-26",
  },
  {
    address: "0xCb8aAFb794B52AB421550257aC95fBd7d415dd5D",
    label: "internal",
    note: "Kite settler (pays Kite gas)",
    since: "2026-11-26",
  },
  {
    address: "0x5a26f55FA55D17C8E7B9277Bd41AD1Ba1C04ceA3",
    label: "internal",
    note: "demo seller A",
    since: "2026-11-26",
  },
  {
    address: "0xd31d342fcD1297738553B876e926Bd2c869a38f9",
    label: "internal",
    note: "demo seller B",
    since: "2026-11-26",
  },
  {
    address: "0x6313E6CA15F751D64C16BA72bC71dBAF35eBaE54",
    label: "internal",
    note: "lab agent ISSUER-A (Gate Market testbed)",
    since: "2026-11-26",
  },
  {
    address: "0xD4BeCD22D3CEE01b1B388C065C1Fdd1F967EE776",
    label: "internal",
    note: "lab agent ISSUER-B (Gate Market testbed)",
    since: "2026-11-26",
  },
  {
    address: "0x8Bf6De67D0B9705520Cdf5a348f5763e2175F363",
    label: "internal",
    note: "lab agent ORCHESTRATOR (Gate Market testbed)",
    since: "2026-11-26",
  },
  {
    address: "0xee18C8bdB822Dcaf988Af2E09141D3e6Ea80e560",
    label: "internal",
    note: "lab agent WORKER-CODE (Gate Market testbed)",
    since: "2026-11-26",
  },
  {
    address: "0x2cd53E449F6cF45c51f600e167b4D2630128c8F3",
    label: "internal",
    note: "lab agent WORKER-EXTRACT (Gate Market testbed)",
    since: "2026-11-26",
  },
  {
    address: "0xf1B22259b355434a3b84A381Ef5c8d96Eb6C1614",
    label: "internal",
    note: "lab agent HEDGER (Gate Market testbed)",
    since: "2026-11-26",
  },
];

/** The traffic class of a payment, from its paying wallet alone. */
export function labelForPayer(
  payer: string,
  labels: readonly LabelledWallet[] = WALLET_LABELS,
): TrafficClass {
  const p = payer.toLowerCase();
  return labels.find((w) => w.address.toLowerCase() === p)?.label ?? "organic";
}

export interface PaymentRow {
  payer: string;
  network: string;
  /** atomic units, as the settlement log stores them */
  amount: string;
}

export interface TrafficTotals {
  payments: number;
  /** atomic units summed per network, as decimal strings (no floats) */
  amountByNetwork: Record<string, string>;
}

/** Payments and amounts per traffic class: organic, internal and campaign, each reported on its own. */
export function trafficSummary(
  rows: readonly PaymentRow[],
  labels: readonly LabelledWallet[] = WALLET_LABELS,
): Record<TrafficClass, TrafficTotals> {
  const sums: Record<TrafficClass, { payments: number; amounts: Map<string, bigint> }> = {
    organic: { payments: 0, amounts: new Map() },
    internal: { payments: 0, amounts: new Map() },
    campaign: { payments: 0, amounts: new Map() },
  };
  for (const row of rows) {
    const s = sums[labelForPayer(row.payer, labels)];
    s.payments++;
    s.amounts.set(row.network, (s.amounts.get(row.network) ?? 0n) + BigInt(row.amount || "0"));
  }
  const out = (s: (typeof sums)[TrafficClass]): TrafficTotals => ({
    payments: s.payments,
    amountByNetwork: Object.fromEntries([...s.amounts].map(([n, a]) => [n, a.toString()])),
  });
  return { organic: out(sums.organic), internal: out(sums.internal), campaign: out(sums.campaign) };
}

/** D1: the label table and a view that classifies every settlement by its payer. */
export const WALLET_LABELS_SCHEMA = `CREATE TABLE IF NOT EXISTS wallet_labels (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (label IN ('internal', 'campaign')),
  note TEXT NOT NULL,
  since TEXT NOT NULL
);
CREATE VIEW IF NOT EXISTS settlements_classified AS
  SELECT s.*, COALESCE((SELECT w.label FROM wallet_labels w WHERE w.address = lower(s.payer)), 'organic') AS traffic
  FROM settlements s;`;

const sqlString = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** Replaces D1's wallet_labels contents with `labels` (addresses lowercased). */
export function walletLabelsSyncSql(labels: readonly LabelledWallet[] = WALLET_LABELS): string {
  const rows = labels.map(
    (w) =>
      `INSERT INTO wallet_labels (address, label, note, since) VALUES (${sqlString(w.address.toLowerCase())}, ${sqlString(w.label)}, ${sqlString(w.note)}, ${sqlString(w.since)});`,
  );
  return ["DELETE FROM wallet_labels;", ...rows].join("\n");
}
