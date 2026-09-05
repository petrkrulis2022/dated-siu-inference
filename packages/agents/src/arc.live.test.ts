import { beforeAll, describe, expect, it } from "vitest";
import {
  buildQuoteBody,
  signQuote,
  quoteHashHex,
  loadDeployment,
  retryUntilConclusive,
  type TouchstoneQuote,
} from "@touchstone/sdk";
import { clientsFor, generateAndFundSeller, type ChainClients } from "./wallets.js";
import { openAndFund, settle, readEscrow, readEscrowUntilMatch } from "./escrow-client.js";
import { LocalSettlementReader, QuoteHashMismatchError } from "./settlement-reader.js";

/**
 * Same suite as live.test.ts, against Arc Testnet's own real deployment
 * (data/deployments/arc-testnet.json) instead of Base Sepolia — a separate file rather than a
 * parameterized version of live.test.ts, since that file's RPC env var name
 * (BASE_SEPOLIA_RPC_URL) is hardcoded, not derived from TOUCHSTONE_CHAIN_NAME. Needs a funded
 * DEPLOYER_PRIVATE_KEY with real Arc Testnet USDC (Arc's own native gas token — see
 * data/deployments/arc-testnet.json's network.note) — stays local-only rather than running in
 * CI, matching live.test.ts's own precedent for write-requiring live suites.
 *
 * The primary rpc.testnet.arc.io endpoint rate-limited under this session's own repeated deploy/
 * read/write traffic — ARC_TESTNET_RPC_URL should point at one of Arc's documented alternate
 * mirrors (e.g. https://rpc.drpc.testnet.arc.io) if the primary trips the same limit.
 */
const RPC_URL = process.env.ARC_TESTNET_RPC_URL;
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const CHAIN_NAME = "arc-testnet";

const canRun = Boolean(RPC_URL && DEPLOYER_KEY);
const describeLive = canRun ? describe : describe.skip;

describeLive("live Arc Testnet: escrow-client + LocalSettlementReader", () => {
  let buyer: ChainClients;
  let seller: ChainClients;
  let quote: TouchstoneQuote;
  let quoteHash: string;
  let settleTxHash: string;
  let escrowAddress: string;
  let usdcAddress: string;
  let actualAmount: bigint;

  beforeAll(async () => {
    const deployment = loadDeployment(CHAIN_NAME);
    escrowAddress = deployment.contracts.TouchstoneEscrow.address;
    usdcAddress = deployment.usdc.address;

    buyer = clientsFor(DEPLOYER_KEY!, RPC_URL!);
    // Arc's real gas price (confirmed live: 29 gwei maxFeePerGas) is far above Base Sepolia's —
    // wallets.ts's default SELLER_GAS_FUNDING_WEI genuinely reverted settle() here with "gas
    // required exceeds allowance" before this was raised. 0.02 native units (also real USDC on
    // Arc) matches what this session's own deployed seller Workers needed to settle successfully.
    const funded = await generateAndFundSeller(buyer, "arc-live-test-seller", 20_000_000_000_000_000n);
    seller = clientsFor(funded.privateKey, RPC_URL!);

    quote = signQuote(
      buildQuoteBody({
        // Same sizing lesson as live.test.ts: 0.01 SIU gives maxAmount 500 minor units, so
        // actualAmount (half) clears TouchstoneEscrow's MIN_SETTLEMENT = 100 floor with margin.
        siu: "0.01",
        pattern: "fixed",
        model: "demo-live-test",
        rateUsdPerSiu: "0.05",
        indexVersion: "SIU-2026a-illustrative-demo",
        printId: "agents-arc-live-test",
        printHash: `0x${"0".repeat(64)}`,
        sellerId: `erc8004:${seller.account.address}`,
        chain: CHAIN_NAME,
        expiresInSeconds: 3600,
      }),
      funded.privateKey,
    );
    quoteHash = quoteHashHex(quote);
    const expiryUnix = BigInt(Math.floor(new Date(quote.expiry).getTime() / 1000));
    const maxAmount = BigInt(quote.settlement[0].amount_max);

    await openAndFund(buyer, usdcAddress, escrowAddress, {
      quoteHash,
      seller: seller.account.address,
      settler: "0x0000000000000000000000000000000000000000",
      maxAmount,
      expiryUnix,
    });

    await readEscrowUntilMatch(buyer, escrowAddress, quoteHash, {
      seller: seller.account.address,
      maxAmount,
      expiryUnix,
    });

    actualAmount = maxAmount / 2n;
    settleTxHash = await settle(seller, escrowAddress, {
      quoteHash,
      actualAmount,
      receiptRef: quoteHash,
    });

    await retryUntilConclusive(
      () => readEscrow(buyer, escrowAddress, quoteHash),
      (escrow) => escrow.status === 2,
    );
  }, 60_000);

  it("readEscrow reflects the real Settled state, with maxAmount surviving settlement", async () => {
    const escrow = await readEscrow(buyer, escrowAddress, quoteHash);
    expect(escrow.status).toBe(2); // Settled
    expect(escrow.maxAmount).toBe(BigInt(quote.settlement[0].amount_max));
  });

  it("readEscrowUntilMatch exhausts its retries and returns the real (non-Open) state rather than hanging", async () => {
    const expected = {
      seller: seller.account.address,
      maxAmount: BigInt(quote.settlement[0].amount_max),
      expiryUnix: BigInt(Math.floor(new Date(quote.expiry).getTime() / 1000)),
    };
    const escrow = await readEscrowUntilMatch(buyer, escrowAddress, quoteHash, expected, {
      attempts: 2,
      delayMs: 100,
    });
    expect(escrow.status).toBe(2);
  });

  it("LocalSettlementReader reads the real settlement, bound to the real quote by hash", async () => {
    const reader = new LocalSettlementReader({
      chainName: CHAIN_NAME,
      rpcUrl: RPC_URL!,
      escrowAddress,
    });
    const settlement = await reader.read(CHAIN_NAME, settleTxHash, quote);
    expect(settlement).not.toBeNull();
    expect(settlement?.quoteHash).toBe(quoteHash);
    expect(settlement?.actualAmountMinorUnits).toBe(actualAmount.toString());
    expect(settlement?.maxAmountMinorUnits).toBe(quote.settlement[0].amount_max);
    expect(settlement?.printRef).toBe(quote.print_id);
  });

  it("LocalSettlementReader rejects a quote that doesn't hash to what was actually settled", async () => {
    const reader = new LocalSettlementReader({
      chainName: CHAIN_NAME,
      rpcUrl: RPC_URL!,
      escrowAddress,
    });
    const wrongQuote: TouchstoneQuote = { ...quote, siu: "9.999" };
    await expect(reader.read(CHAIN_NAME, settleTxHash, wrongQuote)).rejects.toThrow(
      QuoteHashMismatchError,
    );
  });
});
