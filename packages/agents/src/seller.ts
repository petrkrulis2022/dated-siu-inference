import express, { type Express, type Response } from "express";
import { createAdapterFor, withBackoff, type Adapter } from "@touchstone/harness";
import {
  buildQuoteBody,
  signQuote,
  quoteHashHex,
  usdToMinorUnits,
  validateQuote,
  type TouchstoneQuote,
  type ModelRegistryEntry,
} from "@touchstone/sdk";
import { readEscrowUntilMatch, escrowMatchesQuote, settle } from "./escrow-client.js";
import { estimatedCeiling, realizedCost, type PriceSnapshotEntryPrices } from "./pricing.js";
import { logIssuedQuote } from "./quote-log.js";
import type { ChainClients } from "./wallets.js";

/** Neither a real print (`data/prints/` is empty in this environment) nor a real ERC-8004
 * registry exists — these are labeled illustrative placeholders, never presented as real
 * published values. See docs/demo.md and pricing.ts's header comment. */
const ILLUSTRATIVE_INDEX_VERSION = "SIU-2026a-illustrative-demo";
const ILLUSTRATIVE_PRINT_ID = "demo-no-real-print-published-yet";
const ILLUSTRATIVE_PRINT_HASH = `0x${"0".repeat(64)}`;

export interface SellerOptions {
  label: string;
  clients: ChainClients;
  privateKeyHex: string;
  registryEntry: ModelRegistryEntry;
  prices: PriceSnapshotEntryPrices;
  /** This seller's own asking price per SIU — see pricing.ts's header comment. */
  rateUsdPerSiu: string;
  openrouterApiKey: string;
  escrowAddress: string;
  chainName: string;
  /** Fixed, seller-known task — "trivial paid inference service" (build1-spec.md §11): not a
   * general-purpose endpoint, one canned demo task. */
  prompt: string;
  maxOutputTokens: number;
  quoteTtlSeconds: number;
  /** Passed straight to `createAdapterFor`'s routing option — see its own doc comment.
   * Undefined/false (the default) keeps this seller pinned to `registryEntry.host`, matching
   * the real measurement path. Only set this if a specific host's congestion is blocking a
   * demo run and `withBackoff`'s retries aren't enough — never for anything that produces a
   * real print. */
  allowUnpinnedRouting?: boolean;
  log: (line: string) => void;
}

function sellerIdFor(clients: ChainClients): string {
  return `erc8004:${clients.account.address}`;
}

/** Real chain/model/filesystem calls, injectable so `seller.test.ts` can assert the
 * 402-vs-funded HTTP branching without touching live chain, a real model, or the real
 * filesystem — the underlying real implementations (`readEscrowUntilMatch`, `settle`,
 * `logIssuedQuote`) are proven separately, against live Base Sepolia, in `live.test.ts`. */
export interface SellerDeps {
  readEscrowUntilMatch: typeof readEscrowUntilMatch;
  settle: typeof settle;
  logIssuedQuote: typeof logIssuedQuote;
  adapter: Adapter;
}

function defaultDeps(options: SellerOptions): SellerDeps {
  return {
    readEscrowUntilMatch,
    settle,
    logIssuedQuote,
    adapter: createAdapterFor(
      options.registryEntry,
      { openrouter: options.openrouterApiKey },
      { allowUnpinnedRouting: options.allowUnpinnedRouting },
    ),
  };
}

/**
 * `POST /infer` — build1-spec.md §11's seller side. No `quote` in the body: unpaid, issues a
 * fresh signed `touchstone-quote` and responds `402` (the quote rides in `extensions.touchstone_quote`,
 * alongside a minimal x402-v2-shaped `accepts` array — confirmed against `@x402/core`'s real
 * `PaymentRequired` shape). A `quote` in the body: the buyer claims it funded escrow for that
 * exact quote — stateless by the same design as `verify_receipt` (P14 step 2): the seller
 * recomputes `quoteHash` from the resupplied quote and reads the real escrow state itself,
 * rather than trusting anything the buyer says or keeping its own quote index.
 */
export function createSellerApp(
  options: SellerOptions,
  deps: SellerDeps = defaultDeps(options),
): Express {
  const app = express();
  app.use(express.json());
  const { adapter } = deps;

  app.post("/infer", (req, res) => {
    handleInfer(req.body as { quote?: unknown } | undefined, res).catch((err: unknown) => {
      options.log(
        `[${options.label}] /infer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!res.headersSent) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  async function handleInfer(body: { quote?: unknown } | undefined, res: Response): Promise<void> {
    if (!body?.quote) {
      const { siu, siuMax } = estimatedCeiling(
        options.prompt,
        options.maxOutputTokens,
        options.prices,
        options.rateUsdPerSiu,
      );
      const quoteBody = buildQuoteBody({
        siu,
        pattern: "cap",
        siuMax,
        model: options.registryEntry.id,
        rateUsdPerSiu: options.rateUsdPerSiu,
        indexVersion: ILLUSTRATIVE_INDEX_VERSION,
        printId: ILLUSTRATIVE_PRINT_ID,
        printHash: ILLUSTRATIVE_PRINT_HASH,
        sellerId: sellerIdFor(options.clients),
        chain: options.chainName,
        expiresInSeconds: options.quoteTtlSeconds,
      });
      const quote = signQuote(quoteBody, options.privateKeyHex);
      options.log(
        `[${options.label}] issuing quote: siu=${quote.siu} (cap ${quote.siu_max}), ` +
          `amount_usd_max=$${quote.amount_usd_max}`,
      );
      // Best-effort: a console-convenience side effect must never break a real quote response.
      await deps.logIssuedQuote(quote).catch((err: unknown) => {
        options.log(
          `[${options.label}] (non-fatal) failed to log quote for the console: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      res.status(402).json({
        x402Version: 2,
        error: "Payment Required",
        resource: "/infer",
        accepts: [
          {
            scheme: "exact",
            network: options.chainName,
            asset: quote.settlement[0].address,
            amount: quote.settlement[0].amount_max,
            payTo: options.clients.account.address,
            maxTimeoutSeconds: options.quoteTtlSeconds,
            extra: {},
          },
        ],
        extensions: { touchstone_quote: quote },
      });
      return;
    }

    const quote = body.quote as TouchstoneQuote;
    const validation = validateQuote(quote);
    if (!validation.valid) {
      res.status(400).json({ error: `quote fails validation: ${validation.errors.join("; ")}` });
      return;
    }

    const quoteHash = quoteHashHex(quote);
    const expiryUnix = BigInt(Math.floor(new Date(quote.expiry).getTime() / 1000));
    const maxAmount = BigInt(quote.settlement[0].amount_max);
    const expected = { seller: options.clients.account.address, maxAmount, expiryUnix };
    const escrow = await deps.readEscrowUntilMatch(
      options.clients,
      options.escrowAddress,
      quoteHash,
      expected,
    );
    if (!escrowMatchesQuote(escrow, expected)) {
      res.status(402).json({ error: `escrow for ${quoteHash} is not open and funded as quoted.` });
      return;
    }

    options.log(
      `[${options.label}] escrow confirmed funded — performing the real inference call...`,
    );
    // The harness's batch orchestrator (runOrchestrator) already retries transient upstream
    // errors this way; this live HTTP-triggered call had no equivalent, and hit it directly —
    // OpenRouter's shared free-tier provider pools return 429 intermittently under load,
    // confirmed live: the identical request succeeded seconds later with no other change.
    // withBackoff (@touchstone/harness) already exists for exactly this, just unused here.
    const result = await withBackoff(() =>
      adapter(options.registryEntry.model_string, options.prompt, {
        temperature: 0,
        max_tokens: options.maxOutputTokens,
      }),
    );

    const actualUsd = realizedCost(result.usage.input, result.usage.output, options.prices);
    const actualAmountRaw = BigInt(usdToMinorUnits(actualUsd));
    const actualAmount = actualAmountRaw > maxAmount ? maxAmount : actualAmountRaw;
    const receiptRef = quoteHash; // 32-byte stand-in ref, same convention this session's earlier live smoke tests used

    const settleTxHash = await deps.settle(options.clients, options.escrowAddress, {
      quoteHash,
      actualAmount,
      receiptRef,
    });
    options.log(
      `[${options.label}] settled: actual=$${actualUsd} (of $${quote.amount_usd_max} max) — tx ${settleTxHash}`,
    );

    res.json({
      text: result.text,
      usage: result.usage,
      actual_usd: actualUsd,
      settle_tx_hash: settleTxHash,
      chain: options.chainName,
    });
  }

  return app;
}
