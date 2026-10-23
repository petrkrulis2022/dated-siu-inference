import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { standInSeat } from "../runner/stand-in-models.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance } from "../tasks/instances.js";
import { FakeMcp, LIVE_LAG } from "./fake-mcp.js";
import { McpSessionsAborted } from "./incident-guard.js";
import { runMcpAnswer } from "./session.js";
import type { MessagesApi } from "./anthropic-loop.js";
import { toMcpInstance } from "./variants.js";

let f: FixtureDay;
let tmp: string;
beforeAll(async () => {
  f = await fixtureDay(undefined, {}, LIVE_LAG);
});
afterAll(() => f.cleanup());
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cr-svc-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const play = (api: MessagesApi) => {
  const instance = drawInstances(f.day, "2".repeat(64), 1)
    .map((i) => toMcpInstance(i, f.day)?.instance)
    .find((i): i is Instance => i?.task === "CR-PL") as Instance;
  return runMcpAnswer({
    api,
    mcp: new FakeMcp({ backend: f.backend, today: f.day.window, lagByModel: LIVE_LAG }),
    ledger: new SpendLedger({
      store: new MemoryLedgerStore(),
      policy: {
        dailyCapUsd: "9",
        providers: { anthropic: { budgetUsd: "100", since: "2026-01-01T00:00:00Z" } },
      },
    }),
    seat: standInSeat("solver", { id: "claude-haiku-4-5" }),
    instance,
    window: f.day.window,
    daySha256: "d".repeat(64),
    sessionsDir: join(tmp, "sessions"),
  });
};

describe("a model-call failure that is the provider's or the network's is not a result about the model (D122; 2026-10-21: a Haiku session was recorded as call-failed after a TypeError)", () => {
  it("a request that never gets a response (fetch failed) aborts the run and records nothing", async () => {
    const api: MessagesApi = {
      send: async () => {
        throw new TypeError("fetch failed");
      },
    };
    const err = await play(api).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpSessionsAborted);
    expect((err as McpSessionsAborted).incident.kind).toBe("model-api-failure");
    expect((err as McpSessionsAborted).incident.detail).toContain("TypeError");
  });

  it.each([429, 500, 529])(
    "a provider that keeps answering %i through the client's retries is the same",
    async (status) => {
      const api: MessagesApi = { send: async () => ({ status, json: {}, attempts: 3 }) };
      const err = await play(api).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpSessionsAborted);
      expect((err as McpSessionsAborted).incident.detail).toContain(`HTTP ${status}`);
    },
  );

  it("but a refusal of the request itself (400) is deterministic: a failed call, recorded as one", async () => {
    const api: MessagesApi = { send: async () => ({ status: 400, json: {}, attempts: 1 }) };
    const out = await play(api);
    expect(out.record.passed).toBe(false);
    expect(out.record.error).toBe("HTTP 400");
    expect(out.record.failure_classes).toContain("call-failed");
  });
});
