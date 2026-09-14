import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { composeTweetText } from "./tweet-text.js";

function print(overrides: Partial<Print> = {}): Print {
  return {
    print_id: "2026-09-14",
    date: "2026-09-14",
    dated_siu: "0.0110",
    exchange_rate_table: [
      { model_id: "a" },
      { model_id: "b" },
      { model_id: "c", excluded_reason: "provider outage" },
    ],
    ...overrides,
  } as unknown as Print;
}

describe("composeTweetText", () => {
  it("counts only qualifying (non-excluded) models, never a hardcoded number", () => {
    const text = composeTweetText(print());
    expect(text).toContain("measured across 2 models");
  });

  it("uses the print's own real dated_siu verbatim — never invents a number", () => {
    const text = composeTweetText(print({ dated_siu: "0.0090" }));
    expect(text).toContain("Dated SIU today: $0.0090");
  });

  it("matches the exact approved template", () => {
    const text = composeTweetText(print());
    expect(text).toBe(
      "Dated SIU today: $0.0110\n" +
        "The benchmark price of one unit of completed AI work — a fixed basket of tasks, measured " +
        "across 2 models by actually buying the inference and reconciling against invoices.\n" +
        "Published daily. Signed. Anchored on Base.\n" +
        "https://prints.touchstoneassay.com",
    );
  });
});
