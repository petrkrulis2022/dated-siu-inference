import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLedgerStore, LedgerUnreadable } from "./store.js";
import type { SpendEntry } from "./types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cr-ledger-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (n: number): SpendEntry => ({
  at: `2026-10-23T16:00:0${n}.000Z`,
  provider: "anthropic",
  usd: "0.010000",
  part: "mcp",
  model: "claude-sonnet-5",
  key: "CR_ANTHROPIC_API_KEY",
  what: `CR-SM-1#${n}`,
});
const line = (n: number) => `${JSON.stringify(entry(n))}\n`;
const make = () => {
  const path = join(dir, "ledger.jsonl");
  const log = join(dir, "repairs.log");
  return {
    path,
    log,
    store: new FileLedgerStore(path, log, () => new Date("2026-10-23T17:00:00Z")),
  };
};

describe("a ledger whose last line a crash tore (seen 2026-10-23: 173 NUL bytes after the last good entry)", () => {
  it("reads the good entries and skips the torn line, so spend-so-far is not lost and the run can see the cap", () => {
    const { path, store } = make();
    writeFileSync(path, line(1) + line(2) + "\0".repeat(173));
    expect(store.load().map((e) => e.what)).toEqual(["CR-SM-1#1", "CR-SM-1#2"]);
  });

  it("repairs it on the next append: cuts it off, adds the entry on a line of its own, and records the repair", () => {
    const { path, log, store } = make();
    writeFileSync(path, line(1) + line(2) + "\0".repeat(173));
    store.append(entry(3));
    expect(readFileSync(path, "utf-8")).toBe(line(1) + line(2) + line(3));
    expect(store.repairs).toHaveLength(1);
    expect(store.repairs[0]).toContain("173 bytes");
    expect(readFileSync(log, "utf-8")).toContain("interrupted write");
    expect(store.load()).toHaveLength(3);
  });

  it("treats half a line as torn too", () => {
    const { path, store } = make();
    writeFileSync(path, line(1) + '{"at":"2026-10-23T16:00:02.000Z","provider":"anth');
    expect(store.load()).toHaveLength(1);
    store.append(entry(2));
    expect(store.load().map((e) => e.what)).toEqual(["CR-SM-1#1", "CR-SM-1#2"]);
    expect(store.repairs).toHaveLength(1);
  });

  it("keeps a whole last line that only lacks its newline, and starts the new entry on a fresh line", () => {
    const { path, store } = make();
    writeFileSync(path, line(1) + JSON.stringify(entry(2)));
    store.append(entry(3));
    expect(readFileSync(path, "utf-8")).toBe(line(1) + line(2) + line(3));
    expect(store.repairs).toEqual([]);
  });

  it("a bad line ANYWHERE ELSE is real corruption and stops the run with LedgerUnreadable", () => {
    const { path, store } = make();
    writeFileSync(path, line(1) + "not json\n" + line(3));
    expect(() => store.load()).toThrow(LedgerUnreadable);
    expect(() => store.append(entry(4))).toThrow(LedgerUnreadable);
    expect(readFileSync(path, "utf-8")).toBe(line(1) + "not json\n" + line(3)); // untouched
  });

  it("leaves a healthy ledger exactly as it is", () => {
    const { path, store } = make();
    writeFileSync(path, line(1));
    store.append(entry(2));
    expect(readFileSync(path, "utf-8")).toBe(line(1) + line(2));
    expect(store.repairs).toEqual([]);
  });
});
