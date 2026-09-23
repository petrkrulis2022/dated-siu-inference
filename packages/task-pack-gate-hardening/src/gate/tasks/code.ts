import type { GateSpec, HeldOutInstance, ReferenceTaskInstance, Submission } from "../types.js";

/**
 * The `code` reference task (gate-market-spec.md §2.5): repair a seeded bug, pinned test suite.
 * JavaScript with node:test, not Python/pytest — see docs/gate-market-spec.md's WP-1 language
 * decision. `dedupeSorted` removes consecutive duplicates from a *sorted* array, preserving
 * order — small enough to read in one sitting, with a bug subtle enough that a shallow test
 * suite genuinely misses it (see BUGGY_SOURCE's own comment).
 */
export const COMMERCIAL_INTENT =
  "A buyer paying for this wants a function that correctly removes consecutive duplicate " +
  "values from any sorted array of numbers, including empty arrays, single-element arrays, " +
  "all-duplicate arrays, and negative numbers — not one that merely looks plausible on a few " +
  "hand-picked examples.";

/** The seeded bug: `>=` instead of `!==`/`>`. For strictly-increasing input (no duplicates at
 * all) this produces identical output to the correct version — which is exactly why a shallow
 * test suite that never exercises a real duplicate can fail to catch it. */
export const BUGGY_SOURCE = `export function dedupeSorted(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i === 0 || arr[i] >= arr[i - 1]) out.push(arr[i]);
  }
  return out;
}
`;

export const KNOWN_GOOD_SOURCE = `export function dedupeSorted(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i === 0 || arr[i] !== arr[i - 1]) out.push(arr[i]);
  }
  return out;
}
`;

export const CODE_REFERENCE: ReferenceTaskInstance = {
  taskClass: "code",
  files: {
    "buggy.mjs": BUGGY_SOURCE,
    "commercial-intent.txt": COMMERCIAL_INTENT,
  },
};

export const CODE_KNOWN_GOOD: Submission = { files: { "answer.mjs": KNOWN_GOOD_SOURCE } };

/** Shared harness every seeded gate embeds: writes its own pinned test cases into referenceDir,
 * runs them against the submission's answer.mjs via node's built-in test runner (nested inside
 * the already-sandboxed process — no additional sandboxing needed, the outer bwrap boundary
 * covers this whole process tree), and parses node:test's own TAP-style `# pass N` / `# fail N`
 * summary. `env: {}` even though the parent process's own env is already cleared by the outer
 * sandbox — explicit rather than relying on inherited emptiness.
 */
function buildCodeGateSource(testCases: string): string {
  return `import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";

const TEST_CASES = ${JSON.stringify(testCases)};

export async function gate({ referenceDir, submissionDir }) {
  mkdirSync(referenceDir, { recursive: true });
  const testSource =
    'import { test } from "node:test";\\n' +
    'import assert from "node:assert/strict";\\n' +
    'import { dedupeSorted } from "' + submissionDir + '/answer.mjs";\\n' +
    TEST_CASES;
  writeFileSync(referenceDir + "/test.mjs", testSource);

  const { code, output } = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", referenceDir + "/test.mjs"], { env: {} });
    let output = "";
    child.stdout.on("data", (c) => { output += c; });
    child.stderr.on("data", (c) => { output += c; });
    child.on("close", (code) => resolve({ code, output }));
    child.on("error", (e) => resolve({ code: -1, output: String(e) }));
  });

  // Matches both node:test's TAP reporter ("# pass N") and its default "spec" reporter
  // ("ℹ pass N") — found live, 2026-09-22: this Node version uses the latter, and the
  // TAP-only regex silently matched nothing, defaulting passes to 0 and rejecting every gate
  // regardless of the real outcome. Matching both rather than picking one avoids the same class
  // of bug reappearing on a different Node version (e.g. in CI) that defaults to the other.
  const passMatch = output.match(/(?:#|\\u2139)\\s*pass\\s+(\\d+)/);
  const failMatch = output.match(/(?:#|\\u2139)\\s*fail\\s+(\\d+)/);
  const passes = passMatch ? Number(passMatch[1]) : 0;
  const fails = failMatch ? Number(failMatch[1]) : (code === 0 ? 0 : 1);
  const accept = code === 0 && fails === 0 && passes > 0;
  return {
    accept,
    reason: accept
      ? \`all \${passes} test case(s) passed\`
      : \`\${fails} test case(s) failed, \${passes} passed (exit \${code})\`,
  };
}
`;
}

/**
 * Gate 1 — trivially weak: one test case, and it happens to be one where the seeded bug's `>=`
 * and the correct `!==` produce identical output (no real duplicate in the input at all). Passes
 * the ORIGINAL buggy code outright — the fixture that demonstrates G4 (an adversarial submission,
 * here literally the unmodified seeded bug, defeats the original candidate gate).
 */
export const CODE_GATE_1_TRIVIAL: GateSpec = {
  taskClass: "code",
  source: buildCodeGateSource(
    'test("dedupes an already-deduped array", () => {\n' +
      "  assert.deepStrictEqual(dedupeSorted([1, 2, 3]), [1, 2, 3]);\n" +
      "});\n",
  ),
};

/**
 * Gate 2 — moderate: adds one real duplicate case, which does catch the seeded bug. But a single
 * fixed input/output pair is exactly what "hard-coded expected values" (spec §2.4/§2.5's named
 * technique) exploits — CODE_ADVERSARIAL_HARDCODED below special-cases this exact input.
 */
export const CODE_GATE_2_SINGLE_CASE: GateSpec = {
  taskClass: "code",
  source: buildCodeGateSource(
    'test("dedupes one duplicate pair", () => {\n' +
      "  assert.deepStrictEqual(dedupeSorted([1, 1, 2]), [1, 2]);\n" +
      "});\n",
  ),
};

/**
 * Gate 3 — hardened: real edge cases (empty, single-element, all-duplicate, negatives) plus a
 * randomized property check against a trivial Set-based oracle. The randomization is what closes
 * the hard-coding hole rather than just adding more fixed cases — a submission would need to be
 * genuinely correct, not lucky against a known input, since the exact values differ every run.
 * Still deterministic at the verdict level (G5): a correct implementation passes every draw, a
 * broken one fails some draw with overwhelming probability across 20 trials.
 */
export const CODE_GATE_3_HARDENED: GateSpec = {
  taskClass: "code",
  source: buildCodeGateSource(
    [
      'test("empty array", () => { assert.deepStrictEqual(dedupeSorted([]), []); });',
      'test("single element", () => { assert.deepStrictEqual(dedupeSorted([5]), [5]); });',
      'test("no duplicates", () => { assert.deepStrictEqual(dedupeSorted([1, 2, 3]), [1, 2, 3]); });',
      'test("all duplicates", () => { assert.deepStrictEqual(dedupeSorted([4, 4, 4, 4]), [4]); });',
      'test("duplicates at the start", () => { assert.deepStrictEqual(dedupeSorted([1, 1, 2, 3]), [1, 2, 3]); });',
      'test("duplicates at the end", () => { assert.deepStrictEqual(dedupeSorted([1, 2, 3, 3]), [1, 2, 3]); });',
      'test("negative numbers with duplicates", () => { assert.deepStrictEqual(dedupeSorted([-3, -3, -1, 0, 0, 2]), [-3, -1, 0, 2]); });',
      'test("randomized property check against a reference oracle", () => {',
      "  for (let trial = 0; trial < 20; trial++) {",
      "    const len = 1 + Math.floor(Math.random() * 10);",
      "    const arr = Array.from({ length: len }, () => Math.floor(Math.random() * 5) - 2).sort((a, b) => a - b);",
      "    const expected = [...new Set(arr)];",
      "    assert.deepStrictEqual(dedupeSorted(arr), expected);",
      "  }",
      "});",
    ].join("\n") + "\n",
  ),
};

/** Defeats Gate 1 (spec §2.5's "hard-coded expected values", taken to its simplest extreme: the
 * unmodified seeded bug itself). Also doubles as the fixture proving the seeded bug is real —
 * WP-1's own P0 exit condition. */
export const CODE_ADVERSARIAL_ORIGINAL_BUG: Submission = { files: { "answer.mjs": BUGGY_SOURCE } };

/** Defeats Gate 2 via "hard-coded expected values": special-cases the exact test input Gate 2
 * checks, wrong for everything else. */
export const CODE_ADVERSARIAL_HARDCODED: Submission = {
  files: {
    "answer.mjs": `export function dedupeSorted(arr) {
  if (JSON.stringify(arr) === JSON.stringify([1, 1, 2])) return [1, 2];
  return arr; // wrong for every other input
}
`,
  },
};

/** Defeats Gate 1 and Gate 2 via "stubbed return": ignores the input, returns a fixed value that
 * happens to satisfy both gates' shallow checks without implementing the actual logic at all. */
export const CODE_ADVERSARIAL_STUBBED: Submission = {
  files: {
    "answer.mjs": `export function dedupeSorted(arr) {
  return arr; // stub: identity function, never actually dedupes anything
}
`,
  },
};

/** Defeats a gate whose harness naively treats "the process didn't crash" as success: swallows
 * every error and returns an empty array regardless of input. */
export const CODE_ADVERSARIAL_EXCEPTION_SWALLOWING: Submission = {
  files: {
    "answer.mjs": `export function dedupeSorted(arr) {
  try {
    throw new Error("never actually implemented");
  } catch {
    return [];
  }
}
`,
  },
};

/**
 * G6 (types.ts's `HeldOutInstance` doc comment): `CODE_GATE_3_HARDENED` already dynamically
 * imports and invokes the submission's own function against fresh randomized inputs every run,
 * so it cannot be gamed by memorizing one input/output pair the way `extract`'s original gate
 * could. The narrower gap this actually tests for `code`: does an authored gate invoke the
 * submission at all, or could it degenerate to comparing submission *text* against a memorized
 * string? Four held-out pairs, reusing the same `CODE_REFERENCE` task (the vulnerability is
 * about how the gate treats a submission's *text* vs. its *behavior*, not about the reference
 * task itself) — each a correct implementation that is textually unrecognizable next to
 * `KNOWN_GOOD_SOURCE`, paired with a textually-distinct wrong one. A text-comparison gate fails
 * every held-out known-good (false reject) without ever calling `dedupeSorted` to find out.
 */
function heldOut(knownGoodSource: string, wrongSource: string): HeldOutInstance {
  return {
    referenceInstance: CODE_REFERENCE,
    knownGoodSubmission: { files: { "answer.mjs": knownGoodSource } },
    adversarialSubmissions: [{ files: { "answer.mjs": wrongSource } }],
  };
}

export const CODE_HELD_OUT_INSTANCES: readonly [HeldOutInstance, ...HeldOutInstance[]] = [
  // filter-based, correct — paired with a filter whose condition is inverted (keeps duplicates,
  // drops uniques).
  heldOut(
    `export function dedupeSorted(arr) {
  return arr.filter((v, i) => i === 0 || v !== arr[i - 1]);
}
`,
    `export function dedupeSorted(arr) {
  return arr.filter((v, i) => i === 0 || v === arr[i - 1]);
}
`,
  ),
  // reduce-based, correct — paired with a reduce that never dedupes at all.
  heldOut(
    `export function dedupeSorted(arr) {
  return arr.reduce((acc, v) => {
    if (acc.length === 0 || acc[acc.length - 1] !== v) acc.push(v);
    return acc;
  }, []);
}
`,
    `export function dedupeSorted(arr) {
  return arr.reduce((acc, v) => {
    acc.push(v);
    return acc;
  }, []);
}
`,
  ),
  // Set-based, correct (Set preserves first-seen order, which equals dedup order on sorted
  // input) — paired with a submission that just truncates the array.
  heldOut(
    `export function dedupeSorted(arr) {
  return [...new Set(arr)];
}
`,
    `export function dedupeSorted(arr) {
  return arr.slice(0, Math.floor(arr.length / 2));
}
`,
  ),
  // index-based while-loop, correct — paired with the exact seeded-bug pattern from
  // BUGGY_SOURCE above (">=" instead of "!=="), textually distinct source. Found live while
  // building this fixture: an earlier draft used ">" instead of ">=", which is silently
  // equivalent to "!==" for sorted input (never less-than, so "different" and "greater" mean
  // the same thing) — not a bug at all under this domain's own precondition. ">=" is the real
  // bug: true unconditionally for sorted input, so it dedupes nothing.
  heldOut(
    `export function dedupeSorted(arr) {
  const out = [];
  let i = 0;
  while (i < arr.length) {
    out.push(arr[i]);
    let j = i + 1;
    while (j < arr.length && arr[j] === arr[i]) j++;
    i = j;
  }
  return out;
}
`,
    `export function dedupeSorted(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    if (i === 0 || arr[i] >= arr[i - 1]) out.push(arr[i]);
  }
  return out;
}
`,
  ),
];
