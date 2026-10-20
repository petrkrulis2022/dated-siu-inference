import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CR_PUBLIC_DIR_REL,
  PRIVATE_DIR,
  PRIVATE_DIR_REL,
  REPO_ROOT,
  privatePath,
} from "./paths.js";

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" });

describe("privatePath: licensed data has one home and code cannot leave it", () => {
  it("resolves inside data/private/blockworks", () => {
    expect(PRIVATE_DIR_REL).toBe("data/private/blockworks");
    expect(privatePath("snapshots", "2026-10-20", "q.json")).toBe(
      join(PRIVATE_DIR, "snapshots", "2026-10-20", "q.json"),
    );
    expect(privatePath()).toBe(PRIVATE_DIR);
  });

  it("refuses a path that climbs out or is absolute, so a bug cannot write licensed data to a tracked place", () => {
    expect(() => privatePath("..", "..", "prints", "x.json")).toThrow(
      /outside the private Blockworks directory/,
    );
    expect(() => privatePath("snapshots", "..", "..", "x")).toThrow(/outside/);
    expect(() => privatePath("/etc/passwd")).toThrow(/outside/);
    expect(() => privatePath("a/../../b")).toThrow(/outside/);
  });

  it("allows a name that merely starts with two dots", () => {
    expect(privatePath("..snap")).toBe(join(PRIVATE_DIR, "..snap"));
  });
});

describe("the repository never tracks licensed Blockworks data (D71)", () => {
  it("has nothing tracked under data/private/", () => {
    expect(git("ls-files", "data/private").trim()).toBe("");
  });

  it("ignores data/private/ in git, so a stray `git add` cannot pick a snapshot up", () => {
    expect(() =>
      git("check-ignore", "-q", `${PRIVATE_DIR_REL}/snapshots/2026-10-20/query.json`),
    ).not.toThrow();
    expect(() => git("check-ignore", "-q", "data/private/anything/at/all.json")).not.toThrow();
    expect(readFileSync(join(REPO_ROOT, ".gitignore"), "utf-8")).toMatch(/^data\/private\/$/m);
  });

  it("commits only the files the plan allows under data/lab/cr/: budgets, the frozen output allowances (token counts per task), the spend ledger, hash manifests and seed commitments", () => {
    const allowed =
      /^data\/lab\/cr\/(README\.md|budgets\.json|allowances\.json|spend-ledger\.jsonl|manifests\/[0-9]{4}-[0-9]{2}-[0-9]{2}\.json|seeds\/[0-9]{4}-[0-9]{2}-[0-9]{2}\.json)$/;
    const tracked = git("ls-files", CR_PUBLIC_DIR_REL)
      .split("\n")
      .filter((l) => l !== "");
    const stray = tracked.filter((f) => !allowed.test(f));
    // A new kind of file here is a deliberate decision: widen this list only after checking it carries no Blockworks data or row-level derivative.
    expect(stray).toEqual([]);
  });

  it("keeps every workflow from naming the private path or uploading artifacts, so nothing licensed reaches CI storage", () => {
    const dir = join(REPO_ROOT, ".github/workflows");
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      const text = readFileSync(join(dir, f), "utf-8");
      expect(text, `${f} names data/private`).not.toContain("data/private");
      expect(
        text,
        `${f} uploads an artifact: review that it cannot include Blockworks data, then update this test`,
      ).not.toContain("upload-artifact");
    }
  });
});
