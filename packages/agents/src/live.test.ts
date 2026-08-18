import { beforeAll, describe, expect, it } from "vitest";
import {
  buildQuoteBody,
  signQuote,
  quoteHashHex,
  loadDeployment,
  type TouchstoneQuote,
} from "@touchstone/sdk";
import { clientsFor, generateAndFundSeller, type ChainClients } from "./wallets.js";
import { openAndFund, settle, readEscrow, readEscrowUntilMatch } from "./escrow-client.js";
import { LocalSettlementReader, QuoteHashMismatchError } from "./settlement-reader.js";

/**
 * P13's lesson, restated once more for this package: every test that touches the chain runs
 * against live Base Sepolia, not a fake — proven directly during this file's own development,
 * where the first real run of `seller.ts` hit a genuine RPC-lag false rejection that no mock
 * would ever have surfaced (see `readEscrowUntilMatch`'s header comment in escrow-client.ts).
 *
 * Needs a funded `DEPLOYER_PRIVATE_KEY`, unlike `@touchstone/mcp-server`'s `on-chain.test.ts` (which
 * only reads pre-mined historical transactions and needs no key) — this suite funds and settles
 * a fresh real escrow itself, so it stays local-only rather than running in CI, matching
 * `@touchstone/mcp-server`'s `testnet.live.test.ts` precedent for write-requiring live suites.
 */
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const CHAIN_NAME = process.env.TOUCHSTONE_CHAIN_NAME ?? "base-sepolia";

const canRun = Boolean(RPC_URL && DEPLOYER_KEY);
const describeLive = canRun ? describe : describe.skip;

describeLive("live Base Sepolia: escrow-client + LocalSettlementReader", () => {
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
    const funded = await generateAndFundSeller(buyer, "live-test-seller");
    seller = clientsFor(funded.privateKey, RPC_URL!);

    quote = signQuote(
      buildQuoteBody({
        siu: "0.001",
        pattern: "fixed",
        model: "demo-live-test",
        rateUsdPerSiu: "0.05",
        indexVersion: "SIU-2026a-illustrative-demo",
        printId: "agents-live-test",
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

    // Same RPC-lag lesson, hitting the *other* side this time: settle()'s own eth_estimateGas
    // pre-flight can be served by a node that hasn't yet seen the just-confirmed openAndFund,
    // reverting EscrowNotOpen against what looks (from that node) like a never-funded escrow.
    // seller.ts's real HTTP flow never hits this because readEscrowUntilMatch always runs before
    // settle() — reproduce that same ordering here rather than calling settle() immediately.
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

    // The same RPC-lag lesson yet again (see readEscrowUntilMatch's header comment) — even with
    // waitForTransactionReceipt confirming the settle mined, a read against a different
    // load-balanced RPC node moments later can still observe pre-settle state. Confirmed live
    // while writing this file: the very first run of these assertions saw status Open (1), not
    // Settled (2), immediately after this beforeAll returned. Poll until it converges before any
    // `it` block runs, rather than baking a retry into every individual assertion below.
    for (let i = 0; i < 5; i++) {
      const escrow = await readEscrow(buyer, escrowAddress, quoteHash);
      if (escrow.status === 2) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
    }
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
