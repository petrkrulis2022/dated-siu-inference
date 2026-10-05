import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildQuoteBody, signQuote, type TouchstoneQuote } from "@touchstone/sdk";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners, DRY_LOOP_NANO_USD_PER_SIU } from "./context.js";
import { printDateToUnixDay, SERIES_COMMODITY } from "../chain/rate-attestation.js";
import { erc8004IdFor, type AgentId } from "../identity/resolve.js";
import { buildToolArgs, type JobEnvelope } from "../loop/full-run.js";
import { QuoteBoard } from "../loop/quote-board.js";
import type { Runner } from "../runner.js";

/**
 * The same quote, paid in each asset, from the payer's side of the chain.
 *
 * Every other parity test derives its expectation from the formula the code uses, which is the
 * assumption under test and so cannot see it being wrong (§4.6ai). This one does not: a real payer
 * pays one quote in USDC and an identical one in fSIU, and what is compared is how much USDC
 * actually LEFT ITS BALANCE each time, read from the chain. The quotes are deliberately OFF the
 * print — the buyer types the rate into `request_quote`, and nothing makes it the print's.
 */
describe("price parity, observed on real bytecode", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;
  const PRINT_ID = "dry-loop-illustrative";
  const JOB_ID = "price-parity";

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  let turn = 0;
  const usdcOf = async (agent: AgentId): Promise<bigint> => {
    const rec = await runners.ORCHESTRATOR.callTool(
      "get_balances",
      { account: devnet.agents[agent].address },
      { turn: ++turn, jobId: JOB_ID },
    );
    return BigInt((rec.result as { usdc: { integerMinorUnits: string } }).usdc.integerMinorUnits);
  };

  async function quoteFrom(seller: AgentId, siu: string, rate: string): Promise<TouchstoneQuote> {
    const body = buildQuoteBody({
      siu,
      model: "dry-loop-fixture",
      rateUsdPerSiu: rate,
      indexVersion: "SIU-2026a",
      printId: PRINT_ID,
      printHash: `0x${"11".repeat(32)}`,
      sellerId: erc8004IdFor(devnet.agents[seller].address),
      chain: "base-sepolia",
      expiresInSeconds: 3600,
      pattern: "fixed",
    });
    return signQuote(
      { ...body, settlement: [{ ...body.settlement[0], address: devnet.deployment.usdc.address }] },
      devnet.agents[seller].privateKeyHex,
    );
  }

  // (size in SIU, rate typed into the quote). Print is $0.01/SIU. Prices: $0.10, $0.036, $0.0030.
  const CASES = [
    ["2", "0.0500"], // 5x the print
    ["4", "0.0090"], // below the print
    ["1", "0.0030"], // well below the print
  ] as const;

  for (const [siu, rate] of CASES) {
    it(`${siu} SIU quoted at $${rate}/SIU (print $0.01): paying in fSIU takes the same USDC out of the payer as paying in USDC`, async () => {
      const viaUsdc = await quoteFrom("WORKER-CODE", siu, rate);
      const viaClaim = await quoteFrom("WORKER-EXTRACT", siu, rate);
      const priceMinor = BigInt(viaUsdc.settlement[0].amount_max);

      const b0 = await usdcOf("ORCHESTRATOR");
      await runners.ORCHESTRATOR.callTool(
        "pay",
        { quote: viaUsdc, settler: "0x0000000000000000000000000000000000000000" },
        { turn: ++turn, jobId: JOB_ID },
      );
      const b1 = await usdcOf("ORCHESTRATOR");
      const paidInUsdc = b0 - b1;

      const board = new QuoteBoard();
      const request = board.postRequest("ORCHESTRATOR", viaClaim);
      board.postIssuedQuote(request.requestId, viaClaim);
      const now = Math.floor(Date.now() / 1000);
      const args = await buildToolArgs(
        "pay_with_claim",
        { requestId: request.requestId },
        {
          job: { taskClass: "code" } as unknown as JobEnvelope,
          board,
          agentAddressByAgentId: {},
          deployment: devnet.deployment,
          windowFrom: BigInt(now - 60),
          windowTo: BigInt(now + 3600),
          mintContext: {
            publisherPrivateKeyHex: devnet.publisherPrivateKeyHex,
            printId: PRINT_ID,
            series: SERIES_COMMODITY,
            printDate: printDateToUnixDay(new Date().toISOString().slice(0, 10)),
            nanoUsdPerSiu: DRY_LOOP_NANO_USD_PER_SIU,
            validitySeconds: 3600n,
          },
        },
      );
      const b2 = await usdcOf("ORCHESTRATOR");
      await runners.ORCHESTRATOR.callTool("pay_with_claim", args, { turn: ++turn, jobId: JOB_ID });
      const b3 = await usdcOf("ORCHESTRATOR");
      const paidInClaim = b2 - b3;

      // The dollar route took the quote's stated price — a sanity check on the measuring itself.
      expect(paidInUsdc).toBe(priceMinor);
      // The claim route took at least that, and short of it by less than one milli-SIU at the print
      // ($0.00001 = 10 minor units): no discount, and no meaningful premium.
      expect(paidInClaim).toBeGreaterThanOrEqual(paidInUsdc);
      expect((paidInClaim - paidInUsdc) * 1_000_000n).toBeLessThan(DRY_LOOP_NANO_USD_PER_SIU);
    }, 120_000);
  }
});
