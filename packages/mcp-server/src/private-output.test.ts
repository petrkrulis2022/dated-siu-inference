import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertGitIgnored } from "./private-output.js";

// A real, throwaway git repository: the guard asks git itself, so the test does too.
let repo: string;
let outside: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "private-output-"));
  outside = mkdtempSync(join(tmpdir(), "private-output-outside-"));
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, ".gitignore"), "data/private/\n");
  mkdirSync(join(repo, "data", "public"), { recursive: true });
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("assertGitIgnored", () => {
  it("allows a path git ignores, even before its directory exists", () => {
    expect(() => assertGitIgnored(join(repo, "data", "private", "payments", "2026-11-26.csv"))).not.toThrow();
  });

  it("refuses a path git would track", () => {
    expect(() => assertGitIgnored(join(repo, "data", "public", "2026-11-26.csv"))).toThrow(/refusing/);
    expect(() => assertGitIgnored(join(repo, "2026-11-26.csv"))).toThrow(/refusing/);
  });

  it("refuses a path outside any git repository, which git cannot be ignoring", () => {
    expect(() => assertGitIgnored(join(outside, "2026-11-26.csv"))).toThrow(/refusing/);
  });

  it("refuses a file git already tracks, even under an ignored directory", () => {
    const tracked = join(repo, "data", "private", "tracked.csv");
    mkdirSync(join(repo, "data", "private"), { recursive: true });
    writeFileSync(tracked, "x\n");
    execFileSync("git", ["-C", repo, "add", "-f", "data/private/tracked.csv"]);
    expect(() => assertGitIgnored(tracked)).toThrow(/refusing/);
  });
});
