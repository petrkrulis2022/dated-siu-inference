import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { F2_CAVEAT, MECHANISM_CAVEAT } from "./caveat.js";

function repoRoot(): string {
  // packages/gate-market-agents/src/skills/caveat.test.ts -> repo root is five levels up, same
  // depth as chain/deployment.ts's own repoRoot() (src/<subdir>/<file>).
  return path.resolve(fileURLToPath(import.meta.url), "../../../../..");
}

function specText(): string {
  return readFileSync(path.join(repoRoot(), "docs/gate-market-spec.md"), "utf-8");
}

describe("MECHANISM_CAVEAT / F2_CAVEAT — spec §1.1, verbatim", () => {
  it("matches the spec's own text exactly (markdown bold stripped, not reworded)", () => {
    const spec = specText();

    const mechanismStart = spec.indexOf(
      "Both issuers in this run are backed by Touchstone's own API accounts.",
    );
    const mechanismParagraph = spec
      .slice(mechanismStart, spec.indexOf("\n\n", mechanismStart))
      .replace(/^> ?/gm, "")
      .replace(/\*\*/g, "")
      .trim();
    expect(MECHANISM_CAVEAT).toBe(mechanismParagraph);

    const f2Start = spec.indexOf("And on F2 specifically");
    const f2Paragraph = spec
      .slice(f2Start, spec.indexOf("\n\n", f2Start))
      .replace(/^> ?/gm, "")
      .replace(/\*\*/g, "")
      .replace(/\*/g, "")
      .trim();
    expect(F2_CAVEAT).toBe(f2Paragraph);
  });

  it("carries the specific words that matter — 'mechanism, not demand' and 'cannot default'", () => {
    expect(MECHANISM_CAVEAT).toContain("proves mechanism, not demand");
    expect(F2_CAVEAT).toContain("cannot default");
    expect(F2_CAVEAT).toContain("price-risk transfer only");
  });
});
