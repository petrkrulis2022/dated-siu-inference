import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { composeTweetText } from "./tweet-text.js";

function print(overrides: Partial<Print> = {}): Print {
  return {
    print_id: "2026-09-13",
    date: "2026-09-13",
    dated_siu: "0.0089",
    ...overrides,
  } as Print;
}

describe("composeTweetText", () => {
  it("states provisional plainly, and links to this print's own page", () => {
    const text = composeTweetText(print(), false);
    expect(text).toBe(
      "Dated SIU — $0.0089 (2026-09-13, provisional).\nhttps://prints.touchstoneassay.com/prints/2026-09-13",
    );
  });

  it("states final when a reconciliation record exists for this print", () => {
    const text = composeTweetText(print(), true);
    expect(text).toContain("final");
    expect(text).not.toContain("provisional");
  });

  it("never invents a number — uses the print's own real dated_siu and print_id verbatim", () => {
    const text = composeTweetText(print({ print_id: "2026-09-12-frontier", dated_siu: "0.0091" }), false);
    expect(text).toContain("$0.0091");
    expect(text).toContain("prints/2026-09-12-frontier");
  });
});
