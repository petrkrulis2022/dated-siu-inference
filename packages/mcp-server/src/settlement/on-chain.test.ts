import { describe, expect, it } from "vitest";
import type { TouchstoneQuote } from "@touchstone/sdk";
import { OnChainSettlementReader, QuoteHashMismatchError } from "./on-chain.js";

/**
 * P13's lesson, restated for P14's contract: "every test that touches the chain runs against
 * live Base Sepolia, not a fake. A mocked reader is self-consistent and proves nothing." So this
 * file never mocks viem or the RPC — every case below reads a real, already-mined transaction on
 * Base Sepolia (chain 84532), produced live while wiring this reader. Fixtures are read-only:
 * mining them once (an `openAndFund` + `settle`, and separately a deliberate double-`settle` to
 * get a genuine reverted receipt) cost real testnet gas; re-reading them costs nothing and never
 * expires, so the suite stays fast and repeatable without needing a funded key of its own.
 */
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
const ESCROW_ADDRESS = "0xb9708BC05B15efC9dB494b2013125A44dc614757";

const describeLive = RPC_URL ? describe : describe.skip;

/** The exact signed quote settled by SETTLE_TX below — captured verbatim at the moment it was
 * built and settled live, so quoteHashHex(quote) reproduces the real on-chain quoteHash. */
const SETTLED_QUOTE: TouchstoneQuote = {
  schema_version: "1.1",
  siu: "0.100",
  pattern: "fixed",
  model: "anthropic-sonnet-5",
  rate_usd_per_siu: "1.0000",
  amount_usd_max: "0.1000",
  index_version: "SIU-2026a",
  print_id: "2026-08-16-step2-livetest",
  print_hash: "0xe5fb1ef345df5652346d72a958e55adc43b1722876bde8127c0cab16870408a4",
  seller_id: "erc8004:0xD7CA8219C8AfA07b455Ab7e004FC5381B3727B1e",
  expiry: "2026-08-16T14:42:42.649Z",
  settlement: [
    {
      asset: "usdc",
      chain: "base-sepolia",
      amount_max: "100000",
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    },
  ],
  sig: "0xd9dbddcd12ea6064d16a68b218ce9083796ce81e5cdedcca20226ef9a24c622e0ad82bcb94d5e89042820d53220fd13e1ae72417cbe101aa7753e9d907f02906",
};
const SETTLE_TX = "0x1285be1ee4c0e88594228c9735ff6cdcf83e5b8b08574cfcb7b3362d469b2ccc";

/** A well-formed but different quote (different `siu`, hence a different `sig` and quoteHash),
 * paired deliberately with SETTLE_TX above to prove the reader rejects a mismatch rather than
 * trusting the caller's label for a real settlement. */
const WRONG_QUOTE: TouchstoneQuote = {
  ...SETTLED_QUOTE,
  siu: "0.999",
  sig: `0x${"ab".repeat(64)}`,
};

/** A genuinely mined but Expired escrow — expire() emits no Settled event, so a correct reader
 * must return null here, not fabricate a settlement. */
const EXPIRED_TX = "0x4d29e145e8fe772fb83dfca48966f51c0b74f7f286f14609f28a6bf9899c58bf";
const EXPIRED_QUOTE: TouchstoneQuote = { ...SETTLED_QUOTE, print_id: "2026-08-16-smoke" };

/** A real double-settle attempt against the already-settled escrow above — EscrowNotOpen causes
 * a genuine on-chain revert. Mined with an explicit gas limit (bypassing simulation) specifically
 * so this fixture is a real reverted receipt, not a description of one. */
const REVERTED_TX = "0x52efd559dbc3691aa6ab6c5e6a3daab0dfb73a755e2f73b81cb2c478f49b6af0";

describeLive("OnChainSettlementReader (live Base Sepolia)", () => {
  const reader = new OnChainSettlementReader({
    chainName: "base-sepolia",
    rpcUrl: RPC_URL ?? "",
    escrowAddress: ESCROW_ADDRESS,
  });

  it("reads a real settlement, cryptographically binding it to the supplied quote", async () => {
    const settlement = await reader.read("base-sepolia", SETTLE_TX, SETTLED_QUOTE);
    expect(settlement).not.toBeNull();
    expect(settlement?.quoteHash).toBe(
      "0xd004fe11ade3508d7b776e92c423002f131667f814c0031c7069fc0147ce86be",
    );
    expect(settlement?.actualAmountMinorUnits).toBe("60000");
    expect(settlement?.maxAmountMinorUnits).toBe("100000");
    expect(settlement?.printRef).toBe("2026-08-16-step2-livetest");
  });

  it("rejects a quote that doesn't hash to what was actually settled", async () => {
    await expect(reader.read("base-sepolia", SETTLE_TX, WRONG_QUOTE)).rejects.toThrow(
      QuoteHashMismatchError,
    );
  });

  it("returns null for a real transaction that settled nothing (expire, not settle)", async () => {
    const settlement = await reader.read("base-sepolia", EXPIRED_TX, EXPIRED_QUOTE);
    expect(settlement).toBeNull();
  });

  it("rejects a real reverted transaction rather than treating it as settled", async () => {
    await expect(reader.read("base-sepolia", REVERTED_TX, SETTLED_QUOTE)).rejects.toThrow(
      /reverted on-chain/,
    );
  });

  it("refuses to serve a chain other than the one it was configured for", async () => {
    await expect(reader.read("base", SETTLE_TX, SETTLED_QUOTE)).rejects.toThrow(
      /serves "base-sepolia" only/,
    );
  });
});
