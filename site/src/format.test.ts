import { describe, expect, it } from "vitest";
import { esc, formatDate, percent, truncateHex, usd } from "./format.js";

describe("esc", () => {
  it("escapes HTML-significant characters", () => {
    expect(esc("<script>alert('x')&\"y\"</script>")).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&amp;&quot;y&quot;&lt;/script&gt;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(esc("deepseek-v3.2")).toBe("deepseek-v3.2");
  });
});

describe("usd", () => {
  it("prefixes with a dollar sign", () => {
    expect(usd("0.0383")).toBe("$0.0383");
  });
});

describe("percent", () => {
  it("adds a + sign for positive ratios", () => {
    expect(percent("0.26")).toBe("+26%");
  });

  it("keeps the - sign for negative ratios", () => {
    expect(percent("-0.65")).toBe("-65%");
  });

  it("shows 0% without a sign", () => {
    expect(percent("0")).toBe("0%");
  });

  it("supports decimal places", () => {
    expect(percent("-0.1233", 1)).toBe("-12.3%");
  });
});

describe("truncateHex", () => {
  it("truncates a long hex string with an ellipsis", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const truncated = truncateHex(hash);
    expect(truncated).toContain("…");
    expect(truncated.length).toBeLessThan(hash.length);
    expect(truncated.startsWith("0x")).toBe(true);
  });

  it("leaves a short hex string untouched", () => {
    expect(truncateHex("0xabc")).toBe("0xabc");
  });
});

describe("formatDate", () => {
  it("renders an ISO date as a readable string", () => {
    expect(formatDate("2026-08-14")).toBe("14 Aug 2026");
  });
});
