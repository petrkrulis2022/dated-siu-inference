import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_GOOD_GATE_SOURCE, KNOWN_GOOD_GATE_PROVENANCE } from "./known-good-gate.js";

describe("the pinned gate", () => {
  it("is syntactically valid JavaScript", () => {
    // The test this file should have had from the start. The first version stored the gate in a
    // TEMPLATE literal, and the gate contains `].join('\\n')` — a literal backslash-n inside a JS
    // string, which TypeScript read as an escape and turned into a real newline. The result was
    // an unterminated string: every grading failed `G1: SyntaxError`, and the debug run died on
    // its first window having spent $0.38.
    //
    // Nothing caught it because nothing asked the only question that matters about a pinned
    // fixture: does it parse? A `grep` for backslashes was run and reported none, because the
    // pattern was shell-quoted into a search for TWO backslashes. The fix is not a better grep.
    const dir = mkdtempSync(join(tmpdir(), "pinned-gate-"));
    try {
      const file = join(dir, "gate.mjs");
      writeFileSync(file, KNOWN_GOOD_GATE_SOURCE);
      expect(() => execFileSync(process.execPath, ["--check", file], { stdio: "pipe" })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exports the gate entry point the grader will call", () => {
    expect(KNOWN_GOOD_GATE_SOURCE).toMatch(/export\s+async\s+function\s+gate\s*\(/);
  });

  it("carries its provenance, so nobody has to ask whether it was earned or invented", () => {
    expect(KNOWN_GOOD_GATE_PROVENANCE).toMatch(/p5-three-window-/);
    expect(KNOWN_GOOD_GATE_PROVENANCE).toMatch(/PASS/);
  });

  it("survived the escaping round trip — no stray escape turned into a real character", () => {
    // The specific corruption that happened: `\n` inside a single-quoted string becoming an
    // actual newline. If that recurs, the string is unterminated and this line still holds.
    expect(KNOWN_GOOD_GATE_SOURCE).toContain("].join('\\n')");
  });
});
