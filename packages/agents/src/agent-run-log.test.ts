import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunRecord } from "@touchstone/sdk";
import { agentRunsDir, logAgentRun, taskSpecHash } from "./agent-run-log.js";

function sellerRecord(overrides: Partial<Omit<AgentRunRecord, "receipt_hash">> = {}): Omit<
  AgentRunRecord,
  "receipt_hash"
> {
  return {
    schema_version: "1.0",
    run_id: "11111111-1111-1111-1111-111111111111",
    captured_at: "2026-09-06T00:00:00.000Z",
    role: "seller",
    chain: "base-sepolia",
    quote_hash: `0x${"a".repeat(64)}`,
    methodology_version: "SIU-2026a-illustrative-demo",
    model: "demo-model",
    provider: "openrouter",
    routing_decision: "pinned",
    usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
    latency_ms: 900,
    retry_count: 0,
    fallback_count: null,
    tool_calls: null,
    tool_failures: null,
    quality_gate_result: null,
    human_review_required: null,
    quoted_siu: "1.000000",
    actual_siu: "0.913200",
    usdc_paid: "0.0456",
    task_spec_hash: `0x${"b".repeat(64)}`,
    verify_receipt_matched: null,
    chosen_seller_label: null,
    ...overrides,
  };
}

describe("logAgentRun", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "touchstone-agent-run-log-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the record to <dir>/<run_id>-<role>.json, with a computed receipt_hash", async () => {
    const record = sellerRecord();
    const path = await logAgentRun(record, dir);
    expect(path).toBe(join(dir, "11111111-1111-1111-1111-111111111111-seller.json"));
    const reread = JSON.parse(await readFile(path, "utf-8")) as AgentRunRecord;
    expect(reread.receipt_hash).toMatch(/^0x[0-9a-f]{64}$/);
    // Every other field round-trips exactly as given.
    expect(reread).toMatchObject(record);
  });

  it("creates the directory if it doesn't exist yet", async () => {
    const nested = join(dir, "nested", "agent-runs");
    const path = await logAgentRun(sellerRecord(), nested);
    const reread = JSON.parse(await readFile(path, "utf-8")) as AgentRunRecord;
    expect(reread.run_id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("rejects a record that fails its own published schema, never writing a malformed file", async () => {
    const invalid = { ...sellerRecord(), quote_hash: "not-a-hash" };
    await expect(logAgentRun(invalid, dir)).rejects.toThrow(/fails its own schema/);
  });

  it("computes a different receipt_hash for two records that differ only in one field", async () => {
    const pathA = await logAgentRun(sellerRecord({ run_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }), dir);
    const pathB = await logAgentRun(
      sellerRecord({ run_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", retry_count: 3 }),
      dir,
    );
    const a = JSON.parse(await readFile(pathA, "utf-8")) as AgentRunRecord;
    const b = JSON.parse(await readFile(pathB, "utf-8")) as AgentRunRecord;
    expect(a.receipt_hash).not.toBe(b.receipt_hash);
  });

  it("defaults to data/agent-runs relative to the package's own cwd", () => {
    expect(agentRunsDir().endsWith(join("data", "agent-runs"))).toBe(true);
  });
});

describe("taskSpecHash", () => {
  it("is deterministic for the same prompt and output ceiling", () => {
    expect(taskSpecHash("write a poem", 100)).toBe(taskSpecHash("write a poem", 100));
  });

  it("differs when the prompt differs", () => {
    expect(taskSpecHash("write a poem", 100)).not.toBe(taskSpecHash("write a haiku", 100));
  });

  it("differs when the output ceiling differs", () => {
    expect(taskSpecHash("write a poem", 100)).not.toBe(taskSpecHash("write a poem", 200));
  });
});
