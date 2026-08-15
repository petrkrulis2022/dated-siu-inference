import { describe, expect, it } from "vitest";
import type { Print } from "../types/generated/print.schema.js";
import type { Receipt } from "../types/generated/receipt.schema.js";
import { createDatumClient, type CallToolFn } from "./client.js";

const validPrint: Print = {
  version: "SIU-2026a",
  print_id: "2026-08-15",
  date: "2026-08-15",
  status: "provisional",
  basket_costs: [{ model_id: "A", cost_usd: "0.001" }],
  weights: { source: "equal", values: [{ model_id: "A", weight: "1" }] },
  dated_siu: "0.0019",
  exchange_rate_table: [
    { model_id: "A", usd_per_siu: "0.0019", spread_to_index: "0", siu_per_usd: "526.3" },
  ],
  sensitivity_block: [{ policy_variant: "none", dated_siu: "0.0019", delta: "0" }],
  rounding: {
    dated_siu_dp: 4,
    basket_cost_dp: 6,
    usd_per_siu_dp: 4,
    spread_dp: 4,
    siu_per_usd_dp: 1,
    mode: "ROUND_HALF_UP",
    siu_per_usd_mode: "ROUND_DOWN",
  },
  cost_of_production_usd: "0.06",
  price_snapshot_ref: "snap-1",
  methodology_version: "v0-draft",
  signature: `0x${"ab".repeat(64)}`,
  public_key: `0x${"cd".repeat(33)}`,
} as Print;

const validReceipt: Receipt = {
  schema_version: "1.0",
  quote_hash: `0x${"a".repeat(64)}`,
  chain: "base",
  tx_ref: `0x${"b".repeat(64)}`,
  amount_quoted_usd: "0.0676",
  amount_paid_usd: "0.0676",
  matched: true,
  print_ref: "2026-08-14",
  signature: `0x${"c".repeat(64)}`,
  public_key: `0x${"d".repeat(66)}`,
};

function clientWith(callTool: CallToolFn) {
  return createDatumClient({ callTool });
}

describe("createDatumClient", () => {
  it("getIndex validates the server's result and returns a typed Print", async () => {
    const client = clientWith(async () => validPrint);
    const print = await client.getIndex();
    expect(print.print_id).toBe("2026-08-15");
  });

  it("getIndex throws on a malformed print rather than returning bad data", async () => {
    const client = clientWith(async () => ({ not: "a print" }));
    await expect(client.getIndex()).rejects.toThrow(/malformed print/);
  });

  it("getIndex forwards version/date params to the transport", async () => {
    let seenArgs: unknown;
    const client = clientWith(async (tool, args) => {
      seenArgs = args;
      return tool === "get_index" ? validPrint : undefined;
    });
    await client.getIndex({ version: "SIU-2026a", date: "2026-08-15" });
    expect(seenArgs).toEqual({ version: "SIU-2026a", date: "2026-08-15" });
  });

  it("getQuote returns a shape-checked result", async () => {
    const client = clientWith(async () => ({
      siu_per_call: "0.019",
      usd_per_siu: "0.0483",
      index_version: "SIU-2026a",
      print_id: "2026-08-15",
      print_hash: "0xabc",
    }));
    const result = await client.getQuote({ task_class: "T1", model: "registry-id" });
    expect(result.siu_per_call).toBe("0.019");
  });

  it("getQuote throws when a required field is missing or the wrong type", async () => {
    const client = clientWith(async () => ({ siu_per_call: 0.019 }));
    await expect(client.getQuote({ task_class: "T1", model: "registry-id" })).rejects.toThrow(
      /malformed result/,
    );
  });

  it("convert returns a shape-checked result", async () => {
    const client = clientWith(async () => ({ siu: "0.019", usd: "0.000918" }));
    const result = await client.convert({
      model: "registry-id",
      input_tokens: 1000,
      output_tokens: 500,
    });
    expect(result).toEqual({ siu: "0.019", usd: "0.000918" });
  });

  it("convert throws on a malformed result", async () => {
    const client = clientWith(async () => ({ siu: "0.019" }));
    await expect(
      client.convert({ model: "registry-id", input_tokens: 1000, output_tokens: 500 }),
    ).rejects.toThrow(/malformed result/);
  });

  it("verifyReceipt validates the server's result and returns a typed Receipt", async () => {
    const client = clientWith(async () => validReceipt);
    const receipt = await client.verifyReceipt({ chain: "base", tx_hash: "0xdead" });
    expect(receipt.matched).toBe(true);
  });

  it("verifyReceipt throws on a malformed receipt", async () => {
    const client = clientWith(async () => ({ not: "a receipt" }));
    await expect(client.verifyReceipt({ chain: "base", tx_hash: "0xdead" })).rejects.toThrow(
      /malformed receipt/,
    );
  });
});
