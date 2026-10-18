import { describe, expect, it } from "vitest";
import {
  DataFigures,
  findFigures,
  maskFigures,
  significantDigits,
  ungroundedFigures,
} from "./figures.js";

describe("figures in text", () => {
  it("counts significant digits as written", () => {
    expect(significantDigits("12,345")).toBe(5);
    expect(significantDigits("1.234")).toBe(4);
    expect(significantDigits("1000")).toBe(1);
    expect(significantDigits("12000000")).toBe(2);
    expect(significantDigits("0.0012")).toBe(2);
    expect(significantDigits("1.5e9")).toBe(2);
  });

  it("finds figures with their scale words, and leaves years, ids and hex alone", () => {
    const f = findFigures(
      "Volume was 12.35 billion on 2026-10-18 for qr-1 in TYPE-3, tx 0x1234abcd, up 1,234,567 USD.",
    );
    expect(f.map((x) => x.token)).toEqual(["12.35", "10", "18", "1", "3", "1,234,567"]);
    expect(f[0]?.scale).toBe("billion");
    expect(f[0]?.value.toFixed()).toBe("12350000000");
    expect(f.find((x) => x.token === "1,234,567")?.value.toFixed()).toBe("1234567");
  });

  it("applies k, m, b as scales only when they stand alone after the number", () => {
    expect(findFigures("about 2.5k")[0]?.value.toFixed()).toBe("2500");
    expect(findFigures("about 3.2m ago")[0]?.value.toFixed()).toBe("3200000");
    // "3 months" and "5 bars" are words, not scales
    expect(findFigures("3 months")[0]?.value.toFixed()).toBe("3");
    expect(findFigures("5 bars")[0]?.value.toFixed()).toBe("5");
  });
});

describe("a figure that is in no tool result", () => {
  const shown = new DataFigures([
    '{"volume":"12347000000.5","venue":"alpha","day":"2026-10-17"}',
    "prompt: top 5 venues over three months",
  ]);

  it("is grounded when the data holds it at the precision the agent wrote", () => {
    expect(ungroundedFigures("alpha did 12.35 billion", shown)).toEqual([]);
    expect(ungroundedFigures("alpha did 12,347,000,000", shown)).toEqual([]);
  });

  it("is flagged when the data does not", () => {
    const u = ungroundedFigures("alpha did 13.35 billion, and 98765 elsewhere", shown);
    expect(u.map((x) => x.token)).toEqual(["13.35", "98765"]);
  });

  it("never flags round numbers or small counts: that is scale reasoning, not data", () => {
    expect(ungroundedFigures("a thousand times, 1000x, 12 million, 90 days, top 5", shown)).toEqual(
      [],
    );
  });
});

describe("masking", () => {
  const shown = new DataFigures(['{"v":"482.7"}']);

  it("hides precise figures and keeps the agent's own units and scale words", () => {
    expect(maskFigures("The value 12,345,678.9 USD looks like thousands, not millions.")).toBe(
      "The value [figure] USD looks like thousands, not millions.",
    );
    expect(maskFigures("It is $1234567.5 per day")).toBe("It is $[figure] per day");
  });

  it("hides a three- or four-digit figure only when the agent was shown it", () => {
    expect(maskFigures("v is 482.7 and w is 391.2", shown)).toBe("v is [figure] and w is 391.2");
    expect(maskFigures("v is 482.7")).toBe("v is 482.7");
  });

  it("leaves round numbers, counts, ratios and years visible", () => {
    const t = "I read 3 months, 12 series, a factor of 1000, 2026-10-18, 12 million";
    expect(maskFigures(t, shown)).toBe(t);
  });

  it("changes nothing in text without figures", () => {
    expect(maskFigures("No numbers here.")).toBe("No numbers here.");
  });
});
