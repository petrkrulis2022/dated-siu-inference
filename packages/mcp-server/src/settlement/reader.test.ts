import { describe, expect, it } from "vitest";
import { StubSettlementReader } from "./reader.js";

describe("StubSettlementReader", () => {
  it("rejects rather than fabricating a plausible-looking settlement", async () => {
    await expect(new StubSettlementReader().read()).rejects.toThrow(
      /cannot read on-chain settlements/,
    );
  });

  it("names what to do instead, so a caller with no reader configured isn't left guessing", async () => {
    await expect(new StubSettlementReader().read()).rejects.toThrow(/OnChainSettlementReader/);
  });
});
