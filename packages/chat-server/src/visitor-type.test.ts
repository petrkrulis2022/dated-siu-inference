import { describe, expect, it } from "vitest";
import { classifyVisitor } from "./visitor-type.js";

const SITE = "https://prints.touchstoneassay.com";

describe("classifyVisitor", () => {
  it("classifies a generic HTTP client user-agent as an agent", () => {
    expect(
      classifyVisitor({ userAgent: "node", originOrReferer: null, expectedOrigin: SITE }),
    ).toBe("agent");
    expect(
      classifyVisitor({ userAgent: "python-httpx/0.28.1", originOrReferer: null, expectedOrigin: SITE }),
    ).toBe("agent");
  });

  it("classifies a missing user-agent as an agent", () => {
    expect(classifyVisitor({ userAgent: null, originOrReferer: null, expectedOrigin: SITE })).toBe(
      "agent",
    );
  });

  it("classifies a real browser UA with a matching Origin as human", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
    expect(
      classifyVisitor({ userAgent: ua, originOrReferer: `${SITE}/index.html`, expectedOrigin: SITE }),
    ).toBe("human");
  });

  it("classifies a real browser UA with no matching Origin as unknown — could be a bot spoofing a browser string", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
    expect(classifyVisitor({ userAgent: ua, originOrReferer: null, expectedOrigin: SITE })).toBe(
      "unknown",
    );
  });

  it("classifies an unrecognised, non-generic, non-browser user-agent as unknown", () => {
    expect(
      classifyVisitor({
        userAgent: "SomeUnknownBot/1.0",
        originOrReferer: null,
        expectedOrigin: SITE,
      }),
    ).toBe("unknown");
  });
});
