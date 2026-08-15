import { describe, expect, it } from "vitest";
import { StubSettlementReader } from "./reader.js";

describe("StubSettlementReader", () => {
  it("rejects rather than fabricating a plausible-looking settlement", async () => {
    await expect(new StubSettlementReader().read()).rejects.toThrow(
      /cannot read on-chain settlements/,
    );
  });

  it("names exactly what's missing, so a future implementer knows what to build", async () => {
    await expect(new StubSettlementReader().read()).rejects.toThrow(
      /DatumEscrow's deployed address.*ABI.*RPC endpoint/s,
    );
  });
});
