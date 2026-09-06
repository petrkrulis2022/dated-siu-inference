import {
  checkSpendingMandate,
  quoteHashHex,
  validateQuote,
  type TouchstoneQuote,
  type SpendingMandate,
  type AgentRunRecord,
} from "@touchstone/sdk";
import { openAndFund } from "./escrow-client.js";
import { pickCheaperQuote } from "./quote-compare.js";
import { callVerifyReceipt } from "./mcp-client.js";
import { usdToSiu } from "./pricing.js";
import { logAgentRun } from "./agent-run-log.js";
import type { ChainClients } from "./wallets.js";

export interface SellerEndpoint {
  label: string;
  url: string;
}

const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000";

export interface BuyerRunOptions {
  clients: ChainClients;
  sellers: [SellerEndpoint, SellerEndpoint];
  /** Substitutes for a real Circle Agent Wallet spending policy — no Circle Agent Wallet
   * credentials exist in this environment. See docs/demo.md. Enforced here, in agent code,
   * exactly as the user's fallback instruction specified. */
  mandate: SpendingMandate;
  escrowAddress: string;
  usdcAddress: string;
  chainName: string;
  mcpServerUrl: string;
  log: (line: string) => void;
  /** Real implementation writes to node:fs (data/agent-runs/), unavailable from a Cloudflare
   * Worker with no repo checkout — workers/buyer.ts overrides this with a console-only stub,
   * the same accommodation workers/seller.ts already makes for logIssuedQuote. Defaults to the
   * real implementation for the Node/CLI path (cli/demo.ts, cli/agent-loop.ts), where it's
   * exactly what's wanted. */
  logAgentRun?: typeof logAgentRun;
}

async function requestQuote(seller: SellerEndpoint): Promise<TouchstoneQuote> {
  const res = await fetch(`${seller.url}/infer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (res.status !== 402) {
    throw new Error(`${seller.label}: expected 402 Payment Required, got ${res.status}.`);
  }
  const body = (await res.json()) as { extensions?: { touchstone_quote?: unknown } };
  const quote = body.extensions?.touchstone_quote;
  const validation = validateQuote(quote);
  if (!validation.valid) {
    throw new Error(`${seller.label}: quote failed validation: ${validation.errors.join("; ")}`);
  }
  return validation.data;
}

/**
 * The full quote → compare → escrow → settle → verify loop — build1-spec.md §11/§14. Every step
 * is real: real HTTP 402 responses, real on-chain funding and settlement on Base Sepolia, and a
 * real `verify_receipt` call against a live `@touchstone/mcp-server` instance. Labeled a testbed, not
 * traction, throughout docs/demo.md — these are our own agents.
 */
export async function runBuyerDemo(options: BuyerRunOptions): Promise<void> {
  const [sellerA, sellerB] = options.sellers;

  options.log(`[buyer] requesting a quote from ${sellerA.label} (${sellerA.url})...`);
  const quoteA = await requestQuote(sellerA);
  options.log(`[buyer] ${sellerA.label} quoted siu=${quoteA.siu} (cap ${quoteA.siu_max})`);
  const decisionA = checkSpendingMandate(quoteA, options.mandate);
  if (!decisionA.accepted) {
    throw new Error(`${sellerA.label}'s quote rejected by spending mandate: ${decisionA.detail}`);
  }

  options.log(`[buyer] requesting a quote from ${sellerB.label} (${sellerB.url})...`);
  const quoteB = await requestQuote(sellerB);
  options.log(`[buyer] ${sellerB.label} quoted siu=${quoteB.siu} (cap ${quoteB.siu_max})`);
  const decisionB = checkSpendingMandate(quoteB, options.mandate);
  if (!decisionB.accepted) {
    throw new Error(`${sellerB.label}'s quote rejected by spending mandate: ${decisionB.detail}`);
  }

  const chosenQuote = pickCheaperQuote(quoteA, quoteB);
  const chosenSeller = chosenQuote === quoteA ? sellerA : sellerB;
  options.log(`[buyer] cheaper in SIU: ${chosenSeller.label} (siu=${chosenQuote.siu})`);

  const quoteHash = quoteHashHex(chosenQuote);
  const expiryUnix = BigInt(Math.floor(new Date(chosenQuote.expiry).getTime() / 1000));
  const maxAmount = BigInt(chosenQuote.settlement[0].amount_max);
  const sellerAddress = chosenQuote.seller_id.split(":")[1];
  if (!sellerAddress) {
    throw new Error(`Malformed seller_id "${chosenQuote.seller_id}" — expected "erc8004:0x...".`);
  }

  options.log(`[buyer] funding escrow for quoteHash ${quoteHash} (maxAmount ${maxAmount})...`);
  const fundTxHash = await openAndFund(
    options.clients,
    options.usdcAddress,
    options.escrowAddress,
    {
      quoteHash,
      seller: sellerAddress,
      settler: ADDRESS_ZERO,
      maxAmount,
      expiryUnix,
    },
  );
  options.log(`[buyer] escrow funded — tx ${fundTxHash}`);

  options.log(`[buyer] requesting fulfillment from ${chosenSeller.label} with the funded quote...`);
  const fulfillRes = await fetch(`${chosenSeller.url}/infer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quote: chosenQuote }),
  });
  if (!fulfillRes.ok) {
    throw new Error(
      `${chosenSeller.label} fulfillment failed: ${fulfillRes.status} ${await fulfillRes.text()}`,
    );
  }
  const fulfillment = (await fulfillRes.json()) as {
    text: string;
    usage?: { input: number; output: number; cached_input: number; reasoning: number };
    latency_ms?: number;
    actual_usd: string;
    settle_tx_hash: string;
  };
  options.log(
    `[buyer] received result (settled $${fulfillment.actual_usd}, tx ${fulfillment.settle_tx_hash}): ` +
      `"${fulfillment.text.slice(0, 160).replace(/\s+/g, " ")}"`,
  );

  options.log(`[buyer] calling verify_receipt via the real MCP server...`);
  const receipt = await callVerifyReceipt(options.mcpServerUrl, {
    chain: options.chainName,
    tx_hash: fulfillment.settle_tx_hash,
    quote: chosenQuote,
  });
  options.log(
    `[buyer] receipt: matched=${receipt.matched} amount_paid_usd=$${receipt.amount_paid_usd} ` +
      `amount_quoted_usd=$${receipt.amount_quoted_usd} print_ref=${receipt.print_ref}`,
  );

  // Best-effort, same non-blocking convention as the seller's own agent-run logging: this is
  // unpublished telemetry (AgentRunRecord — the buyer's own vantage point, distinct from the
  // seller's), not settlement, so a write failure here must never look like the demo failed.
  const buyerRunRecord: Omit<AgentRunRecord, "receipt_hash"> = {
    schema_version: "1.0",
    run_id: crypto.randomUUID(),
    captured_at: new Date().toISOString(),
    role: "buyer",
    chain: options.chainName,
    quote_hash: quoteHash,
    methodology_version: chosenQuote.index_version,
    model: chosenQuote.model,
    provider: null,
    routing_decision: null,
    usage: fulfillment.usage ?? null,
    latency_ms: fulfillment.latency_ms ?? null,
    retry_count: null,
    fallback_count: null,
    tool_calls: null,
    tool_failures: null,
    quality_gate_result: null,
    human_review_required: null,
    quoted_siu: chosenQuote.siu,
    actual_siu: usdToSiu(fulfillment.actual_usd, chosenQuote.rate_usd_per_siu),
    usdc_paid: fulfillment.actual_usd,
    task_spec_hash: null,
    verify_receipt_matched: receipt.matched,
    chosen_seller_label: chosenSeller.label,
  };
  const doLogAgentRun = options.logAgentRun ?? logAgentRun;
  await doLogAgentRun(buyerRunRecord).catch((err: unknown) => {
    options.log(
      `[buyer] (non-fatal) failed to log agent-run telemetry: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}
