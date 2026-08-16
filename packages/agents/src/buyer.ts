import {
  checkSpendingMandate,
  quoteHashHex,
  validateQuote,
  type DatumQuote,
  type SpendingMandate,
} from "@datum/sdk";
import { openAndFund } from "./escrow-client.js";
import { pickCheaperQuote } from "./quote-compare.js";
import { callVerifyReceipt } from "./mcp-client.js";
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
}

async function requestQuote(seller: SellerEndpoint): Promise<DatumQuote> {
  const res = await fetch(`${seller.url}/infer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (res.status !== 402) {
    throw new Error(`${seller.label}: expected 402 Payment Required, got ${res.status}.`);
  }
  const body = (await res.json()) as { extensions?: { datum_quote?: unknown } };
  const quote = body.extensions?.datum_quote;
  const validation = validateQuote(quote);
  if (!validation.valid) {
    throw new Error(`${seller.label}: quote failed validation: ${validation.errors.join("; ")}`);
  }
  return validation.data;
}

/**
 * The full quote → compare → escrow → settle → verify loop — build1-spec.md §11/§14. Every step
 * is real: real HTTP 402 responses, real on-chain funding and settlement on Base Sepolia, and a
 * real `verify_receipt` call against a live `@datum/mcp-server` instance. Labeled a testbed, not
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
}
