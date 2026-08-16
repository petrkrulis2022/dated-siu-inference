// Demo buyer and seller agents exercising the quote-compare-escrow-settle-verify loop
// (build1-spec.md §11). TESTBED, not traction — see docs/demo.md.
export {
  clientsFor,
  generateAndFundSeller,
  type ChainClients,
  type FundedSeller,
} from "./wallets.js";
export {
  openAndFund,
  settle,
  readEscrow,
  escrowMatchesQuote,
  type EscrowRead,
} from "./escrow-client.js";
export { LocalSettlementReader, QuoteHashMismatchError } from "./settlement-reader.js";
export {
  DEMO_ILLUSTRATIVE_USD_PER_SIU,
  estimateTokens,
  estimatedCeiling,
  realizedCost,
  type PriceSnapshotEntryPrices,
} from "./pricing.js";
export { pickCheaperQuote } from "./quote-compare.js";
export { createSellerApp, type SellerOptions, type SellerDeps } from "./seller.js";
export { runBuyerDemo, type BuyerRunOptions, type SellerEndpoint } from "./buyer.js";
export { callVerifyReceipt } from "./mcp-client.js";
