export interface ConfigResponse {
  chainName: string;
  chainId: number;
  explorerBaseUrl: string;
  escrowAddress: string;
  attestationAddress: string;
}

export interface PrintVerification {
  schemaValid: boolean;
  signatureSelfConsistent: boolean;
  onChainPublisher: string | null;
  recoveredSigner: string | null;
  matchesOnChainPublisher: boolean;
  anchored: boolean;
  postedAtUnix: string | null;
  verified: boolean;
  error?: string;
}

export interface PrintRow {
  print_id: string;
  date: string;
  status: "provisional" | "final";
  dated_siu: string;
  weights_source: "equal" | "routed-market-share";
  methodology_version: string;
  anchor_tx_hash: string | null;
  anchor_status: string;
  verification: PrintVerification;
}

export interface PrintDetailResponse {
  print: Record<string, unknown>;
  verification: PrintVerification;
}

export interface QuotedInfo {
  siu: string;
  model: string;
  printId: string;
}

export interface EscrowLifecycle {
  quoteHash: string;
  buyer: string;
  seller: string;
  settler: string;
  maxAmount: string;
  status: "open" | "settled" | "expired";
  openedAt: string;
  openedTx: string;
  expiryUnix: string;
  actualAmount?: string;
  feeAmount?: string;
  sellerReceived?: string;
  buyerRefund?: string;
  receiptRef?: string;
  settledAt?: string;
  settledTx?: string;
  expiredAt?: string;
  expiredTx?: string;
  quote: QuotedInfo | null;
}

export interface ActivityAggregates {
  totalUsdcSettledMinorUnits: string;
  totalSiuTransacted: string;
  byBuyer: Record<string, { count: number; volumeMinorUnits: string }>;
  bySeller: Record<string, { count: number; volumeMinorUnits: string }>;
}

export interface ActivityResponse {
  lifecycles: EscrowLifecycle[];
  aggregates: ActivityAggregates;
}

export interface QuotedVsPaidRow {
  quoteHash: string;
  seller: string;
  buyer: string;
  amountQuotedUsd: string;
  amountPaidUsd: string;
  matched: boolean;
  settledAt: string;
  settledTx: string;
}

export interface QuotedVsPaidResponse {
  rows: QuotedVsPaidRow[];
  unknownQuoteCount: number;
}

export interface ModelsResponse {
  rateHistory: Record<
    string,
    {
      date: string;
      print_id: string;
      usd_per_siu: string | null;
      spread_to_index: string | null;
      siu_per_usd: string | null;
      excluded_reason: string | null;
    }[]
  >;
  gateHistory: Record<string, { print_id: string; task_class: string; passed: boolean }[]>;
}

export interface HealthResponse {
  latestPrint: { print_id: string; date: string } | null;
  gateFailuresInLatestPrint: { print_id: string; model_id: string; reason: string }[];
  subsidisedModels: {
    model_id: string;
    price_in_usd_per_1m: string;
    price_out_usd_per_1m: string;
  }[];
  priceSnapshotIsStale: boolean;
  priceSnapshotTimestamp: string | null;
  unanchoredPrints: { print_id: string; date: string; anchorStatus: string }[];
  staleProvisionalPrints: { print_id: string; date: string; daysSincePublished: number }[];
  publisherEthBalanceWei: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  config: () => getJson<ConfigResponse>("/config"),
  prints: () => getJson<PrintRow[]>("/prints"),
  print: (printId: string) =>
    getJson<PrintDetailResponse>(`/prints/${encodeURIComponent(printId)}`),
  models: () => getJson<ModelsResponse>("/models"),
  activity: () => getJson<ActivityResponse>("/activity"),
  quotedVsPaid: () => getJson<QuotedVsPaidResponse>("/quoted-vs-paid"),
  health: () => getJson<HealthResponse>("/health"),
};
