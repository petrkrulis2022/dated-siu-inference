import { describe, expect, it } from "vitest";
import { findUnmetAsks } from "./digest.js";

describe("findUnmetAsks", () => {
  it("flags a message mentioning provider credits", () => {
    expect(findUnmetAsks(["do you offer provider credits I can prepay?"])).toEqual([
      "provider credits / prepaid compute",
    ]);
  });

  it("flags a message mentioning a token", () => {
    expect(findUnmetAsks(["is there a token I can buy, like wSIU?"])).toEqual([
      "a token, coin, or SIU-denominated instrument",
    ]);
  });

  it("returns no duplicates when several messages hit the same category", () => {
    expect(findUnmetAsks(["any token plans?", "will there be a coin?"])).toEqual([
      "a token, coin, or SIU-denominated instrument",
    ]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(findUnmetAsks(["what is the current dated SIU price?", "how is the basket built?"])).toEqual([]);
  });

  it("can flag more than one category across a batch of messages", () => {
    const hits = findUnmetAsks(["do you sell compute on a marketplace?", "any token coming?"]);
    expect(hits).toContain("a compute marketplace / brokering compute");
    expect(hits).toContain("a token, coin, or SIU-denominated instrument");
    expect(hits).toHaveLength(2);
  });
});
