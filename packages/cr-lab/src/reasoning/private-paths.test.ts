/**
 * Everything the reasoning tooling writes stays in the private directory (D107, D108). Masking hides figures, but an agent's reasoning can still restate Blockworks data, so transcripts,
 * the reasoning text in snapshot records, the daily overview, and the tagging draws, imports and reports must never be able to reach a tracked path.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRIVATE_DIR, REPO_ROOT, assertInPrivate, privatePath } from "../paths.js";

const src = (...p: string[]): string =>
  readFileSync(join(REPO_ROOT, "packages/cr-lab/src", ...p), "utf-8");
const WRITES =
  /\b(?:writeFileSync|appendFileSync|createWriteStream|mkdirSync|renameSync|copyFileSync)\b/;

const WRITTEN = [
  "cr/mcp-sessions/2026-10-18/CR-VS-2026-10-18-1__claude-sonnet-5.json",
  "cr/records/2026-10-18.jsonl",
  "cr/tables/2026-10-18-reasoning.md",
  ...["items.json", "sample-key.json", "meta.json", "page.html", "tags.json", "agreement.md"].map(
    (f) => `cr/tagging/research-real-2026-10-18/${f}`,
  ),
];

describe("where the reasoning tooling keeps what it writes", () => {
  it("puts every default location inside the private directory", () => {
    for (const f of WRITTEN)
      expect(privatePath(...f.split("/")).startsWith(`${PRIVATE_DIR}/`), f).toBe(true);
  });

  it("is ignored by git for every one of them, so a stray `git add` cannot pick any of it up", () => {
    for (const f of WRITTEN)
      expect(
        () =>
          execFileSync("git", ["check-ignore", "-q", `data/private/blockworks/${f}`], {
            cwd: REPO_ROOT,
          }),
        f,
      ).not.toThrow();
  });

  it("keeps the default homes in the code where the test above assumes them", () => {
    expect(src("mcp/session.ts")).toContain('privatePath("cr", "mcp-sessions"');
    expect(src("runner/records.ts")).toContain('privatePath("cr", "records")');
    expect(src("runner/records.ts")).toContain('privatePath("cr", "tables"');
    expect(src("cli/reasoning-tagging.ts")).toContain('const dir = privatePath("cr", "tagging"');
    expect(src("cli/reasoning-overview.ts")).toContain("tablesDir(");
  });
});

describe("a directory the person names", () => {
  it("is accepted inside the private directory and refused anywhere else", () => {
    expect(assertInPrivate(join(PRIVATE_DIR, "cr/tagging/x"))).toBe(
      join(PRIVATE_DIR, "cr/tagging/x"),
    );
    for (const bad of [
      "/tmp/anything",
      join(REPO_ROOT, "data/lab/cr"),
      join(REPO_ROOT, "data/lab/probes"),
      join(PRIVATE_DIR, ".."),
      join(PRIVATE_DIR, "../prints"),
      "relative/elsewhere",
    ])
      expect(() => assertInPrivate(bad), bad).toThrow(/outside the private Blockworks directory/);
  });
});

describe("the code that could write", () => {
  it("writes no file from any reasoning module: only the two commands write, and only to the private directory", () => {
    const dir = join(REPO_ROOT, "packages/cr-lab/src/reasoning");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts")))
      expect(readFileSync(join(dir, f), "utf-8"), `reasoning/${f}`).not.toMatch(WRITES);
    expect(src("mcp/transcript.ts")).not.toMatch(WRITES);
  });

  it("sends every file the tagging command writes through the guarded helper", () => {
    const text = src("cli/reasoning-tagging.ts");
    expect(text.match(/writeFileSync\(/g)).toHaveLength(1);
    expect(text).toContain("writeFileSync(assertInPrivate(file)");
    expect(text.match(/mkdirSync\(/g)).toHaveLength(1);
  });

  it("writes the overview only through the private tables directory", () => {
    const text = src("cli/reasoning-overview.ts");
    expect(text.match(/writeFileSync\(/g)).toHaveLength(1);
    expect(text).toContain("const file = tablesDir(");
    expect(text).toContain("writeFileSync(file,");
  });
});
