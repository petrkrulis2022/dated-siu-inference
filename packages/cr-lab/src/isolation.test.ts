/**
 * The two-way wall between the trial and the daily print (D72), checked by reading the source rather than by trusting review:
 *  - trial code never names a variable the print reads, so it cannot take the print's key or wallet by accident;
 *  - print-side code and every workflow never name a `CR_` variable, so the print cannot take a trial key;
 *  - the Blockworks key is named in one module, which no other package can import.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as publicApi from "./index.js";
import { REPO_ROOT } from "./paths.js";

/** The print's own variables: the model keys, the publisher's signing key and the X credentials. Named here, in a test, and nowhere in trial code. */
const PRINT_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "TOUCHSTONE_PUBLISHER_KEY",
  "TOUCHSTONE_PUBLISHER_ADDRESS",
  "X_API_KEY",
  "X_API_KEY_SECRET",
  "X_ACCESS_TOKEN",
  "X_ACCESS_TOKEN_SECRET",
];

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}

const isSource = (p: string) => /\.(ts|tsx|mjs|js|json|ya?ml|md)$/.test(p);
const isTrialSource = (p: string) => /\.ts$/.test(p) && !/\.test\.ts$/.test(p);
const crSrc = join(REPO_ROOT, "packages/cr-lab/src");
const rel = (p: string) => relative(REPO_ROOT, p);
const named = (text: string, name: string) =>
  new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(text);

describe("the trial never reads what the print reads", () => {
  it("names none of the print's variables anywhere in trial source", () => {
    const files = walk(crSrc, isTrialSource);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(f, "utf-8");
      for (const v of PRINT_VARIABLES) expect(named(text, v), `${rel(f)} names ${v}`).toBe(false);
    }
  });

  it("never calls the print's key loader: keys reach the adapters only through trialKey", () => {
    // `loadApiKeysFromEnv` (packages/harness) reads the print's variable names, so trial code may use the print's adapters but must pass them keys explicitly.
    for (const f of walk(crSrc, isTrialSource)) {
      const text = readFileSync(f, "utf-8");
      expect(text.includes("loadApiKeysFromEnv"), `${rel(f)} calls the print's key loader`).toBe(
        false,
      );
    }
  });

  it("recognises the check: a CR_ name that contains a print name is not a hit, a bare print name is", () => {
    expect(named("CR_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY")).toBe(false);
    expect(named("process.env.ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY")).toBe(true);
    expect(named("X_API_KEY_SECRET", "X_API_KEY")).toBe(false);
  });
});

describe("the print never reads what the trial reads", () => {
  const printSide = [
    "packages/print/src",
    "packages/harness/src",
    "packages/prices/src",
    "packages/sdk/src",
    "packages/basket/src",
    "packages/mcp-server/src",
    "packages/agents/src",
    "site/src",
    "site/static",
    "scripts",
    ".github/workflows",
  ];

  it("names no CR_ variable in print-side code, scripts or any workflow", () => {
    let checked = 0;
    for (const dir of printSide) {
      for (const f of walk(join(REPO_ROOT, dir), isSource)) {
        checked += 1;
        expect(
          /\bCR_[A-Z0-9_]+/.test(readFileSync(f, "utf-8")),
          `${rel(f)} names a CR_ variable`,
        ).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe("the Blockworks key stays inside the data desk", () => {
  it("is not exported from the package, so no other package can import it", () => {
    expect(Object.keys(publicApi)).not.toContain("blockworksKey");
    expect(Object.keys(publicApi)).not.toContain("BLOCKWORKS_KEY_NAME");
  });

  it("is named only by keys.ts and, once it exists, the data desk's own directory", () => {
    for (const f of walk(crSrc, isTrialSource)) {
      const r = relative(crSrc, f);
      if (r === "keys.ts" || r.startsWith("data-desk/")) continue;
      const text = readFileSync(f, "utf-8");
      for (const n of ["BLOCKWORKS_KEY_NAME", "CR_BLOCKWORKS_API_KEY", "blockworksKey"])
        expect(text.includes(n), `${r} names ${n}`).toBe(false);
    }
  });

  it("cannot be deep-imported from outside: the package maps only its index", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "packages/cr-lab/package.json"), "utf-8"));
    expect(Object.keys(pkg.exports)).toEqual(["."]);
  });
});
