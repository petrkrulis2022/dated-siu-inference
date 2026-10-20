import { describe, expect, it } from "vitest";
import { DEFAULT_CHECK_DELAYS_MS, runLoginCheck } from "./login-check.js";
import { McpLoginRequired } from "./live-mcp.js";

const isLogin = (e: unknown): boolean => e instanceof McpLoginRequired;
/** A sleep that records the pauses instead of waiting. */
const recorder = () => {
  const waited: number[] = [];
  return { waited, sleep: async (ms: number) => void waited.push(ms) };
};

describe("the daily login check", () => {
  it("passes on the first try without waiting", async () => {
    const r = recorder();
    const out = await runLoginCheck({
      attempt: async () => undefined,
      isLoginRequired: isLogin,
      sleep: r.sleep,
    });
    expect(out).toEqual({ ok: true, attempts: 1 });
    expect(r.waited).toEqual([]);
  });

  it("a lapsed login is reported at once, with no retry, because a retry cannot fix it", async () => {
    const r = recorder();
    let calls = 0;
    const out = await runLoginCheck({
      attempt: async () => {
        calls++;
        throw new McpLoginRequired();
      },
      isLoginRequired: isLogin,
      sleep: r.sleep,
    });
    expect(out).toMatchObject({ ok: false, kind: "login-required", attempts: 1 });
    expect(calls).toBe(1);
    expect(r.waited).toEqual([]);
  });

  it("an unreachable server that comes back is not an alert: the machine woke before the network", async () => {
    const r = recorder();
    let calls = 0;
    const out = await runLoginCheck({
      attempt: async () => {
        if (++calls < 3) throw new TypeError("fetch failed");
      },
      isLoginRequired: isLogin,
      sleep: r.sleep,
    });
    expect(out).toEqual({ ok: true, attempts: 3 });
    expect(r.waited).toEqual([30_000, 60_000]);
  });

  it("alerts as unreachable, not as a login problem, only after every try has failed", async () => {
    const r = recorder();
    const out = await runLoginCheck({
      attempt: async () => {
        throw new TypeError("fetch failed: https://mcp.example/secret-path");
      },
      isLoginRequired: isLogin,
      sleep: r.sleep,
    });
    expect(out).toEqual({ ok: false, kind: "unreachable", attempts: 4, why: "TypeError" });
    expect(r.waited).toEqual([...DEFAULT_CHECK_DELAYS_MS]);
    // only the class name is kept: the message could echo a URL or a header
    expect(JSON.stringify(out)).not.toContain("secret-path");
  });

  it("a lapse that shows up after a network failure is still reported as a lapse", async () => {
    const r = recorder();
    let calls = 0;
    const out = await runLoginCheck({
      attempt: async () => {
        if (++calls === 1) throw new TypeError("fetch failed");
        throw new McpLoginRequired();
      },
      isLoginRequired: isLogin,
      sleep: r.sleep,
    });
    expect(out).toMatchObject({ ok: false, kind: "login-required", attempts: 2 });
    expect(r.waited).toEqual([30_000]);
  });

  it("waits about three and a half minutes in all before it gives up", () => {
    expect(DEFAULT_CHECK_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(210_000);
  });
});
