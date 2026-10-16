import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpendIncurred, SpendLedger, SpendStopped, type SpendMeta } from "./ledger.js";
import { FileLedgerStore, MemoryLedgerStore, validateEntry } from "./store.js";
import type { SpendPolicy } from "./types.js";

const POLICY: SpendPolicy = {
  dailyCapUsd: "9",
  providers: {
    anthropic: { budgetUsd: "30", since: "2026-10-01T00:00:00Z" },
    openai: { budgetUsd: "4", since: "2026-10-01T00:00:00Z" },
  },
};
const META: SpendMeta = {
  part: "snapshot",
  model: "claude-sonnet-5",
  key: "CR_ANTHROPIC_API_KEY",
  what: "test call",
};
const OPENAI: SpendMeta = {
  part: "economy",
  model: "gpt-5.1",
  key: "CR_OPENAI_API_KEY",
  what: "test call",
};
const clock = (iso: string) => {
  let t = new Date(iso);
  return { now: () => t, set: (next: string) => (t = new Date(next)) };
};
const ledgerAt = (iso = "2026-10-20T12:00:00Z", policy = POLICY) => {
  const c = clock(iso);
  return { c, ledger: new SpendLedger({ policy, now: c.now }) };
};
const call = (usd: string) => async () => ({ usd, text: "ok" });

describe("the guard stops the trial", () => {
  it("lets calls run up to the $9 daily cap and refuses the one that would pass it, before it starts", async () => {
    const { ledger } = ledgerAt();
    for (let i = 0; i < 3; i++) await ledger.guard("anthropic", "3", META, call("3"));
    let started = false;
    await expect(
      ledger.guard("anthropic", "0.01", META, async () => {
        started = true;
        return { usd: "0.01" };
      }),
    ).rejects.toMatchObject({ name: "SpendStopped", code: "daily-cap", provider: "anthropic" });
    expect(started).toBe(false);
    expect(ledger.report().spentToday).toBe("9.000000");
  });

  it("stops one provider at its budget while another still runs", async () => {
    const { ledger } = ledgerAt();
    await ledger.guard("openai", "2", OPENAI, call("2"));
    await ledger.guard("openai", "2", OPENAI, call("2"));
    await expect(ledger.guard("openai", "0.5", OPENAI, call("0.5"))).rejects.toMatchObject({
      code: "provider-budget",
    });
    await expect(ledger.guard("anthropic", "1", META, call("1"))).resolves.toMatchObject({
      usd: "1",
    });
  });

  it("opens a new UTC day with a fresh daily cap, but the provider budget carries over", async () => {
    const { ledger, c } = ledgerAt("2026-10-20T23:59:00Z");
    await ledger.guard("anthropic", "9", META, call("9"));
    await expect(ledger.guard("anthropic", "1", META, call("1"))).rejects.toMatchObject({
      code: "daily-cap",
    });
    c.set("2026-10-21T00:00:01Z");
    await expect(ledger.guard("anthropic", "9", META, call("9"))).resolves.toBeDefined();
    c.set("2026-10-22T00:00:01Z");
    await ledger.guard("anthropic", "9", META, call("9"));
    c.set("2026-10-23T00:00:01Z");
    await expect(ledger.guard("anthropic", "4", META, call("4"))).rejects.toMatchObject({
      code: "provider-budget",
    }); // 27 of 30 spent
  });

  it("refuses a provider that has no budget, the state before a balance is recorded", async () => {
    const { ledger } = ledgerAt();
    await expect(
      ledger.guard(
        "google",
        "0.001",
        { ...META, model: "gemini", key: "CR_GOOGLE_API_KEY" },
        call("0.001"),
      ),
    ).rejects.toMatchObject({ code: "no-budget" });
  });

  it("holds concurrent calls to the cap: of five $3 calls started together, only three run", async () => {
    const { ledger } = ledgerAt();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        ledger.guard("anthropic", "3", META, async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { usd: "3" };
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused).toHaveLength(2);
    for (const r of refused)
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SpendStopped);
    expect(ledger.report().spentToday).toBe("9.000000");
  });

  it("records the provider's real figure, and an overrun is seen by the next call", async () => {
    const { ledger } = ledgerAt();
    await ledger.guard("anthropic", "1", META, call("8.5")); // projected 1, billed 8.5
    expect(ledger.report().spentToday).toBe("8.500000");
    await expect(ledger.guard("anthropic", "0.6", META, call("0.6"))).rejects.toMatchObject({
      code: "daily-cap",
    });
  });

  it("releases the reservation when a call fails before billing, and records nothing", async () => {
    const { ledger } = ledgerAt();
    await expect(
      ledger.guard("anthropic", "8", META, async () => {
        throw new Error("network down");
      }),
    ).rejects.toThrow("network down");
    expect(ledger.report().spentToday).toBe("0.000000");
    await expect(ledger.guard("anthropic", "8", META, call("8"))).resolves.toBeDefined(); // the $8 was freed
  });

  it("records the spend when the adapter reports a call that failed after it was billed", async () => {
    const { ledger } = ledgerAt();
    await expect(
      ledger.guard("anthropic", "1", META, async () => {
        throw new SpendIncurred("0.42", "timed out after the provider billed");
      }),
    ).rejects.toBeInstanceOf(SpendIncurred);
    expect(ledger.report().spentToday).toBe("0.420000");
  });

  it("will not record a cost that is a number or negative", () => {
    const { ledger } = ledgerAt();
    const r = ledger.reserve("anthropic", "1");
    expect(() => ledger.settle(r, 1 as unknown as string, META)).toThrow(TypeError);
    expect(() => ledger.settle(r, "-1", META)).toThrow(TypeError);
  });

  it("refuses to record a spend paid with a key that is not the trial key for that provider", () => {
    const { ledger } = ledgerAt();
    const r = ledger.reserve("anthropic", "1");
    expect(() => ledger.settle(r, "1", { ...META, key: "ANTHROPIC_API_KEY" })).toThrow(
      /key must be CR_ANTHROPIC_API_KEY/,
    );
    expect(() => ledger.settle(r, "1", { ...META, key: "CR_OPENAI_API_KEY" })).toThrow(
      /key must be CR_ANTHROPIC_API_KEY/,
    );
  });
});

describe("report", () => {
  it("splits today by part and shows each provider's budget, spend and what is left", async () => {
    const { ledger } = ledgerAt();
    await ledger.guard("anthropic", "1", META, call("1.25"));
    await ledger.guard("openai", "1", OPENAI, call("0.75"));
    const r = ledger.report();
    expect(r).toMatchObject({
      day: "2026-10-20",
      dailyCapUsd: "9.00",
      spentToday: "2.000000",
      remainingToday: "7.000000",
      todayByPart: { snapshot: "1.250000", economy: "0.750000" },
    });
    expect(r.providers.find((p) => p.provider === "openai")).toMatchObject({
      budgetUsd: "4",
      spentUsd: "0.750000",
      remainingUsd: "3.250000",
    });
    expect(r.providers.find((p) => p.provider === "xai")).toMatchObject({
      budgetUsd: null,
      remainingUsd: null,
    });
  });
});

describe("the file ledger", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "cr-ledger-"));
    dirs.push(d);
    return join(d, "spend-ledger.jsonl");
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("persists across instances: a new run still sees what was spent", async () => {
    const path = tmp();
    const clk = clock("2026-10-20T12:00:00Z");
    const first = new SpendLedger({
      store: new FileLedgerStore(path),
      policy: POLICY,
      now: clk.now,
    });
    await first.guard("anthropic", "6", META, call("6"));
    const second = new SpendLedger({
      store: new FileLedgerStore(path),
      policy: POLICY,
      now: clk.now,
    });
    expect(second.report().spentToday).toBe("6.000000");
    await expect(second.guard("anthropic", "3.5", META, call("3.5"))).rejects.toMatchObject({
      code: "daily-cap",
    });
  });

  it("writes one JSON line per spend, with the key's NAME and no secret or Blockworks field", async () => {
    const path = tmp();
    const ledger = new SpendLedger({
      store: new FileLedgerStore(path),
      policy: POLICY,
      now: clock("2026-10-20T12:00:00Z").now,
    });
    await ledger.guard("anthropic", "1", META, call("0.0125"));
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      at: "2026-10-20T12:00:00.000Z",
      provider: "anthropic",
      usd: "0.012500",
      part: "snapshot",
      model: "claude-sonnet-5",
      key: "CR_ANTHROPIC_API_KEY",
      what: "test call",
    });
  });

  it("refuses to run past a ledger it cannot read, instead of skipping the bad line and under-counting", () => {
    const path = tmp();
    writeFileSync(
      path,
      `${JSON.stringify({ at: "2026-10-20T12:00:00Z", provider: "anthropic", usd: "1", part: "snapshot", model: "m", key: "CR_ANTHROPIC_API_KEY", what: "x" })}\nnot json\n`,
    );
    expect(() => new FileLedgerStore(path).load()).toThrow(/line 2 is not a valid spend entry/);
    writeFileSync(
      path,
      `${JSON.stringify({ at: "2026-10-20T12:00:00Z", provider: "anthropic", usd: 1, part: "snapshot", model: "m", key: "CR_ANTHROPIC_API_KEY", what: "x" })}\n`,
    );
    expect(() => new FileLedgerStore(path).load()).toThrow(/line 1/);
  });

  it("starts empty when there is no file yet", () => {
    expect(new FileLedgerStore(tmp()).load()).toEqual([]);
  });
});

describe("validateEntry and the memory store", () => {
  const good = {
    at: "2026-10-20T12:00:00Z",
    provider: "xai",
    usd: "0.5",
    part: "smoke",
    model: "grok-4.6",
    key: "CR_XAI_API_KEY",
    what: "x",
  };
  it("accepts a well-formed entry and rejects each malformed field", () => {
    expect(validateEntry(good)).toEqual(good);
    for (const bad of [
      { at: "yesterday" },
      { provider: "nobody" },
      { usd: "0.5e1" },
      { part: "lunch" },
      { model: "" },
      { what: 3 },
      { key: "XAI_API_KEY" },
    ]) {
      expect(() => validateEntry({ ...good, ...bad }), JSON.stringify(bad)).toThrow(TypeError);
    }
    expect(() => validateEntry(null)).toThrow(TypeError);
  });
  it("validates what it is built from and what is appended", () => {
    expect(() => new MemoryLedgerStore([{ ...good, usd: "x" } as never])).toThrow(TypeError);
    expect(new MemoryLedgerStore([good as never]).load()).toHaveLength(1);
  });
});
