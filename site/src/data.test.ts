import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRunRecordsFor, recomputeDatedSiu } from "./data.js";

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), "touchstone-site-data-"));
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

function record(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    run_id: "run-1",
    model_id: "test-model",
    task_class: "T1",
    instance_id: "T1-00",
    seed: 1,
    attempt: 1,
    usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
    latency_ms: 100,
    gate_passed: true,
    raw_response_ref: "run-1.raw.json",
    deviations: [],
    ...overrides,
  };
}

describe("loadRunRecordsFor", () => {
  it("loads real run records, ignoring .raw.json and reconciliation.json", async () => {
    const dir = join(runsDir, "2026-08-30");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run-1.json"), JSON.stringify(record()));
    await writeFile(join(dir, "run-1.raw.json"), JSON.stringify({ some: "raw provider payload" }));
    await writeFile(join(dir, "reconciliation.json"), JSON.stringify({ invoice: "1.23" }));

    const records = await loadRunRecordsFor(runsDir, "2026-08-30");
    expect(records).toHaveLength(1);
    expect(records[0]!.run_id).toBe("run-1");
  });

  it("ignores the declared run-record manifest (index.json) — found live: it was loaded as a " +
    "RunRecord, its undefined model_id/task_class crashing the Models page renderer the first " +
    "time a real publish actually wrote one", async () => {
    const dir = join(runsDir, "2026-08-30");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run-1.json"), JSON.stringify(record()));
    await writeFile(
      join(dir, "index.json"),
      JSON.stringify({
        print_id: "2026-08-30",
        basket_version: "SIU-2026a",
        methodology_version: "v0-draft",
        run_records: ["run-1.json"],
      }),
    );

    const records = await loadRunRecordsFor(runsDir, "2026-08-30");
    expect(records).toHaveLength(1);
    expect(records[0]!.model_id).toBe("test-model");
  });

  it("ignores spend-by-provider.json — the exact same crash as index.json's, one sibling file " +
    "later: it broke this renderer live on 2026-09-28, the first print whose run directory ever " +
    "actually had one, because this file's own exclusion list was a private copy that never " +
    "learned about it", async () => {
    const dir = join(runsDir, "2026-09-28");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run-1.json"), JSON.stringify(record()));
    await writeFile(
      join(dir, "spend-by-provider.json"),
      JSON.stringify({ print_id: "2026-09-28", date: "2026-09-28", spend_usd_by_provider: {} }),
    );

    const records = await loadRunRecordsFor(runsDir, "2026-09-28");
    expect(records).toHaveLength(1);
    expect(records[0]!.model_id).toBe("test-model");
  });
});

describe("recomputeDatedSiu", () => {
  it("recomputes Σ weight × basket_cost from a print's own published fields, to 4 significant figures", () => {
    // Real fixture, not invented: 2026-09-01-commodity.json's own published weights/basket_costs.
    const print = {
      weights: {
        values: [
          { model_id: "deepseek-v3.2", weight: "0.250000" },
          { model_id: "llama-3.3-70b-deepinfra", weight: "0.250000" },
          { model_id: "mistral-small-3.2-24b-instruct", weight: "0.250000" },
          { model_id: "qwen-2.5-72b-instruct", weight: "0.250000" },
        ],
      },
      basket_costs: [
        { model_id: "deepseek-v3.2", cost_usd: "0.001809" },
        { model_id: "llama-3.3-70b-deepinfra", cost_usd: "0.000702" },
        { model_id: "mistral-small-3.2-24b-instruct", cost_usd: "0.000649" },
        { model_id: "qwen-2.5-72b-instruct", cost_usd: "0.002496" },
      ],
    };
    // The real point of this fix: the published headline for this print was "0.0014" (4dp),
    // hiding the real value this recomputation recovers.
    expect(recomputeDatedSiu(print)).toBe("0.001414");
  });

  it("returns undefined rather than silently 0 when a weighted model has no basket_cost", () => {
    const print = {
      weights: { values: [{ model_id: "missing-model", weight: "1.000000" }] },
      basket_costs: [{ model_id: "missing-model", excluded_reason: "failed T3" }],
    };
    expect(recomputeDatedSiu(print)).toBeUndefined();
  });
});

describe("loadChains", () => {
  it("reads Base Sepolia then Arc Testnet from the deployment records, with name, chain id and whether anchoring is live", async () => {
    const { loadChains } = await import("./data.js");
    const chains = await loadChains(resolve(process.cwd(), "../data/deployments"));
    expect(chains.map((c) => c.slug)).toEqual(["base-sepolia", "arc-testnet"]);
    expect(chains[0]).toMatchObject({ name: "Base Sepolia", chainId: 84532, anchoringLive: true });
    expect(chains[1]).toMatchObject({ name: "Arc Testnet", chainId: 5042002, anchoringLive: false });
    expect(chains[1].attestationAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(chains[1].publisherAddress).toBe(chains[0].publisherAddress);
  });
});

describe("withAnchoringFromPrints: whether a further chain is live comes from the prints, never from a typed-in flag", () => {
  const base = { slug: "base-sepolia", attestationAddress: "0xa", publisherAddress: "0xp", explorerBaseUrl: "https://b", anchoringLive: true };
  const arc = { slug: "arc-testnet", attestationAddress: "0xb", publisherAddress: "0xp", explorerBaseUrl: "https://a" };
  const onBase = { chain: "base-sepolia", status: "anchored" as const, tx_hash: "0x1" };
  const withArc = (date: string, status: string) => ({ date, anchor: { ...onBase, additional_anchors: [{ chain: "arc-testnet", status, tx_hash: "0x2" }] } }) as never;

  it("is not live while no print carries a landed Arc anchor, and leaves the first chain alone", async () => {
    const { withAnchoringFromPrints } = await import("./data.js");
    const [b, a] = withAnchoringFromPrints([base, arc], [{ date: "2026-10-14", anchor: onBase } as never, withArc("2026-10-15", "failed"), withArc("2026-10-16", "skipped")]);
    expect(b).toEqual(base);
    expect(a.anchoringLive).toBe(false);
    expect(a.anchoringStartedOn).toBeUndefined();
  });

  it("is live from the OLDEST print with a landed anchor, whatever order the prints come in", async () => {
    const { withAnchoringFromPrints } = await import("./data.js");
    const prints = [withArc("2026-10-17", "anchored"), withArc("2026-10-16", "failed"), withArc("2026-10-15", "already-anchored"), { date: "2026-10-14", anchor: onBase } as never];
    const [, a] = withAnchoringFromPrints([base, arc], prints);
    expect(a).toMatchObject({ anchoringLive: true, anchoringStartedOn: "2026-10-15" });
  });

  it("does not mistake an anchor recorded for some other chain for an Arc anchor", async () => {
    const { withAnchoringFromPrints } = await import("./data.js");
    const other = { date: "2026-10-15", anchor: { ...onBase, additional_anchors: [{ chain: "somewhere-else", status: "anchored", tx_hash: "0x3" }] } } as never;
    const [, a] = withAnchoringFromPrints([base, arc], [other]);
    expect(a.anchoringLive).toBe(false);
  });
});

