import { describe, expect, it } from "vitest";
import { CHANNELS, channelFrom, rememberSessionChannel, sessionChannel } from "./channel.js";

const URL_BASE = "https://mcp.touchstoneassay.com/mcp";

describe("channelFrom", () => {
  it("reads a known listing's tag from ?via=", () => {
    for (const c of CHANNELS) expect(channelFrom(`${URL_BASE}?via=${c}`)).toBe(c);
  });

  it("calls a request with no tag direct", () => {
    expect(channelFrom(URL_BASE)).toBe("direct");
    expect(channelFrom(`${URL_BASE}?via=`)).toBe("direct");
  });

  it("ignores case and surrounding spaces", () => {
    expect(channelFrom(`${URL_BASE}?via=%20McpRush%20`)).toBe("mcprush");
  });

  it("files any tag it does not know under other, so nobody can invent channels in the data", () => {
    expect(channelFrom(`${URL_BASE}?via=somewhere-else`)).toBe("other");
    expect(channelFrom(`${URL_BASE}?via=${"x".repeat(500)}`)).toBe("other");
  });

  it("falls back to the session's remembered tag when a later request drops it", () => {
    expect(channelFrom(URL_BASE, "glama")).toBe("glama");
    expect(channelFrom(`${URL_BASE}?via=circle`, "glama")).toBe("circle");
  });

  it("knows the listings the owner is putting it on", () => {
    expect(CHANNELS).toEqual(expect.arrayContaining(["registry", "glama", "mcprush", "circle"]));
  });
});

describe("the session's remembered tag", () => {
  function fakeKv() {
    const store = new Map<string, { value: string; ttl?: number }>();
    return {
      store,
      kv: {
        get: async (k: string) => store.get(k)?.value ?? null,
        put: async (k: string, value: string, opts?: { expirationTtl?: number }) => void store.set(k, { value, ttl: opts?.expirationTtl }),
      },
    };
  }

  it("is remembered for a tagged session and read back, keyed by a hash rather than the session id", async () => {
    const { kv, store } = fakeKv();
    await rememberSessionChannel(kv, "session-123", "mcprush");
    expect(await sessionChannel(kv, "session-123")).toBe("mcprush");
    const [key, entry] = [...store.entries()][0]!;
    expect(key).not.toContain("session-123");
    expect(entry.ttl).toBe(7 * 24 * 60 * 60);
  });

  it("is not stored for an untagged session, and reads back as nothing for an unknown one", async () => {
    const { kv, store } = fakeKv();
    await rememberSessionChannel(kv, "s", "direct");
    expect(store.size).toBe(0);
    expect(await sessionChannel(kv, "nope")).toBeUndefined();
    expect(await sessionChannel(kv, undefined)).toBeUndefined();
  });

  it("never throws, whatever the store does", async () => {
    const broken = { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } };
    await expect(rememberSessionChannel(broken, "s", "glama")).resolves.toBeUndefined();
    await expect(sessionChannel(broken, "s")).resolves.toBeUndefined();
  });
});
