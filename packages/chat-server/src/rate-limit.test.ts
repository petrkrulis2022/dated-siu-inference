import { describe, expect, it } from "vitest";
import { bumpSessionUsage, checkAndBumpIpNewSessionLimit, checkSessionCap, hashIp } from "./rate-limit.js";

/** A real Workers KV `get(key)` returns a raw string; `get(key, "json")` returns it parsed —
 * unlike mcp-server's own fakeKv() (which always JSON-parses), this fake respects that
 * distinction since rate-limit.ts genuinely uses both forms. */
function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

describe("checkSessionCap / bumpSessionUsage", () => {
  it("allows a session with no recorded usage yet", async () => {
    const kv = fakeKv();
    expect((await checkSessionCap(kv, "s1")).allowed).toBe(true);
  });

  it("refuses once the session hits 20 messages", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 20; i++) await bumpSessionUsage(kv, "s1", "0.001");
    expect((await checkSessionCap(kv, "s1")).allowed).toBe(false);
  });

  it("refuses once the session's spend reaches $0.05, even under 20 messages", async () => {
    const kv = fakeKv();
    await bumpSessionUsage(kv, "s1", "0.03");
    await bumpSessionUsage(kv, "s1", "0.03");
    expect((await checkSessionCap(kv, "s1")).allowed).toBe(false);
  });

  it("keeps separate sessions independent", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 20; i++) await bumpSessionUsage(kv, "s1", "0.001");
    expect((await checkSessionCap(kv, "s2")).allowed).toBe(true);
  });
});

describe("checkAndBumpIpNewSessionLimit", () => {
  it("allows the first five new sessions from an IP within the hour, then refuses the sixth", async () => {
    const kv = fakeKv();
    const now = new Date("2026-09-03T12:00:00Z");
    for (let i = 0; i < 5; i++) {
      expect((await checkAndBumpIpNewSessionLimit(kv, "abc", now)).allowed).toBe(true);
    }
    expect((await checkAndBumpIpNewSessionLimit(kv, "abc", now)).allowed).toBe(false);
  });

  it("keeps separate IP hashes independent", async () => {
    const kv = fakeKv();
    const now = new Date("2026-09-03T12:00:00Z");
    for (let i = 0; i < 5; i++) await checkAndBumpIpNewSessionLimit(kv, "abc", now);
    expect((await checkAndBumpIpNewSessionLimit(kv, "xyz", now)).allowed).toBe(true);
  });
});

describe("hashIp", () => {
  it("produces a stable, non-reversible-looking hex digest", async () => {
    const hash = await hashIp("203.0.113.7");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await hashIp("203.0.113.7"));
  });

  it("hashes different IPs to different digests", async () => {
    expect(await hashIp("203.0.113.7")).not.toBe(await hashIp("203.0.113.8"));
  });
});
