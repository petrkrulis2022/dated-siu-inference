import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { anthropicChat } from "../mcp/anthropic-loop.js";
import { FakeMcp } from "../mcp/fake-mcp.js";
import { runMcpAnswer } from "../mcp/session.js";
import { standInMessagesApi, type AgentKind } from "../mcp/stand-in-agent.js";
import type { TranscriptEvent } from "../mcp/transcript.js";
import type { AnswerRecord, McpSessionSummary } from "../runner/records.js";
import { standInSeat } from "../runner/stand-in-models.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance } from "../tasks/instances.js";
import {
  buildReasoningOverview,
  fileSessionLoader,
  readSession,
  type Flag,
  type SessionFile,
} from "./overview.js";

const record = (
  over: Partial<AnswerRecord> = {},
  mcp: Partial<McpSessionSummary> = {},
): AnswerRecord => ({
  schema: 1,
  window: "2026-10-18",
  part: "mcp",
  task: "CR-VS",
  instance: "CR-VS-1",
  model: "m1",
  provider: "anthropic",
  key: "CR_ANTHROPIC_API_KEY",
  at: "2026-10-18T12:00:00Z",
  data_sha256: "a",
  prompt_sha256: "b",
  day_sha256: "c",
  passed: false,
  fenced: false,
  failure_classes: [],
  failures: [],
  usd: "0.1",
  tokens: { input: 1, output: 1, reasoning: 0, cached_input: 0 },
  latency_ms: 1,
  deviations: [],
  raw_output: "{}",
  mcp: {
    snapshot_check: "same",
    tools_offered: [],
    tools_withheld: [],
    turns: [],
    tool_calls: [],
    session_file: "x.json",
    ...mcp,
  },
  ...over,
});
const ok = (args: Record<string, unknown> = {}, text = '{"a":1}') => ({
  tool: "tabular_data",
  args,
  isError: false,
  text,
});
const bad = (args: Record<string, unknown> = {}) => ({
  tool: "tabular_data",
  args,
  isError: true,
  text: "429",
});
const session = (over: Partial<SessionFile> = {}): SessionFile => ({
  instance: "CR-VS-1",
  model: "m1",
  prompt: "Task: rank the venues over three months",
  relayed: [ok({ model: "a" })],
  final: "{}",
  transcript: [],
  ...over,
});
const flagsOf = (r: AnswerRecord, s: SessionFile) => readSession(r, s).flags;
const say = (kind: "reasoning" | "narration", text: string): TranscriptEvent =>
  kind === "reasoning"
    ? { turn: 1, kind, text, redacted_blocks: 0, empty_blocks: 0 }
    : { turn: 1, kind, text };

describe("the flags are rules on the logs", () => {
  it("no-data-read: an answer with no successful read, and not an answer that never came", () => {
    expect(flagsOf(record(), session({ relayed: [] }))).toContain("no-data-read");
    expect(flagsOf(record(), session({ relayed: [bad()] }))).toContain("no-data-read");
    expect(flagsOf(record(), session({ relayed: [], final: "" }))).not.toContain("no-data-read");
    expect(flagsOf(record(), session())).not.toContain("no-data-read");
  });

  it("error-then-answered: only when the last result was the error", () => {
    expect(flagsOf(record(), session({ relayed: [ok(), bad()] }))).toContain("error-then-answered");
    expect(flagsOf(record(), session({ relayed: [bad(), ok()] }))).not.toContain(
      "error-then-answered",
    );
  });

  it("repeated-call: same tool and arguments, whatever the key order", () => {
    expect(
      flagsOf(record(), session({ relayed: [ok({ a: 1, b: 2 }), ok({ b: 2, a: 1 })] })),
    ).toContain("repeated-call");
    expect(flagsOf(record(), session({ relayed: [ok({ a: 1 }), ok({ a: 2 })] }))).not.toContain(
      "repeated-call",
    );
  });

  it("format-only-failure: failed, and would pass if read leniently", () => {
    expect(flagsOf(record({}, { lenient_passed: true }), session())).toContain(
      "format-only-failure",
    );
    expect(flagsOf(record({ passed: true }, { lenient_passed: true }), session())).not.toContain(
      "format-only-failure",
    );
    expect(flagsOf(record({}, { lenient_passed: false }), session())).not.toContain(
      "format-only-failure",
    );
  });

  it("hit-limit", () => {
    expect(flagsOf(record({}, { limit: "max-turns" }), session())).toContain("hit-limit");
    expect(flagsOf(record(), session())).not.toContain("hit-limit");
  });

  it("placeholder-values: a failed answer of three or more identical numbers", () => {
    const same = '{"a":"1","b":"1","c":"1"}';
    expect(flagsOf(record(), session({ final: same }))).toContain("placeholder-values");
    expect(flagsOf(record(), session({ final: `Here you go: ${same}` }))).toContain(
      "placeholder-values",
    );
    expect(flagsOf(record({ passed: true }), session({ final: same }))).not.toContain(
      "placeholder-values",
    );
    expect(flagsOf(record(), session({ final: '{"a":"1","b":"2","c":"1"}' }))).not.toContain(
      "placeholder-values",
    );
    expect(flagsOf(record(), session({ final: '{"a":"1","b":"1"}' }))).not.toContain(
      "placeholder-values",
    );
  });

  it("read-too-little: an answer when the data read could not answer, or fits a smaller dataset", () => {
    expect(flagsOf(record({}, { snapshot_check: "insufficient" }), session())).toContain(
      "read-too-little",
    );
    expect(flagsOf(record({ failure_classes: ["wrong-dataset"] }), session())).toContain(
      "read-too-little",
    );
    expect(
      flagsOf(record({}, { snapshot_check: "insufficient" }), session({ final: "" })),
    ).not.toContain("read-too-little");
    expect(flagsOf(record(), session())).not.toContain("read-too-little");
  });

  it("figure-not-in-data: a precise figure in reasoning or narration that no tool result or the prompt holds", () => {
    const shown = session({ relayed: [ok({}, '{"volume":"12347000000.5"}')] });
    const fabricated = {
      ...shown,
      transcript: [say("narration", "Alpha traded 98765.43 USD yesterday.")],
    };
    const r = readSession(record(), fabricated);
    expect(r.flags).toContain("figure-not-in-data");
    expect(r.ungrounded).toEqual(["98765.43"]);
    // in the data, at the precision written: not flagged
    expect(
      flagsOf(record(), {
        ...shown,
        transcript: [say("reasoning", "Alpha traded 12.35 billion.")],
      }),
    ).not.toContain("figure-not-in-data");
    // the final answer's own figures are graded against the key, not scanned here
    expect(
      flagsOf(record(), { ...shown, final: '{"share":"98765.43"}', transcript: [] }),
    ).not.toContain("figure-not-in-data");
    // a figure the agent computed and then answered is graded against the key, so it is not flagged; one it stated and never answered is
    const said = { ...shown, final: '{"share":"98765.43"}' };
    expect(
      flagsOf(record(), { ...said, transcript: [say("reasoning", "So the share is 98765.43.")] }),
    ).not.toContain("figure-not-in-data");
    expect(
      flagsOf(record(), {
        ...said,
        transcript: [say("reasoning", "Beta traded 55512.7 meanwhile.")],
      }),
    ).toContain("figure-not-in-data");
    // a round number is scale reasoning, not data
    expect(
      flagsOf(record(), {
        ...shown,
        transcript: [say("reasoning", "that is a thousand times too large, 1000x")],
      }),
    ).not.toContain("figure-not-in-data");
  });

  it("flags nothing on a clean session, and nothing at all for a snapshot-mode record", () => {
    expect(flagsOf(record(), session())).toEqual([]);
    expect(readSession(record({ part: "snapshot", mcp: undefined }), undefined).flags).toEqual([]);
  });
});

describe("the overview of a window", () => {
  let f: FixtureDay;
  let instance: Instance;
  let tmp: string;
  beforeAll(async () => {
    f = await fixtureDay();
    instance = drawInstances(f.day, "7".repeat(64)).find((i) => i.task === "CR-VS") as Instance;
  });
  afterAll(() => f.cleanup());
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cr-overview-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const run = (kind: AgentKind, modelId: string, summary: boolean) =>
    runMcpAnswer({
      chat: anthropicChat(standInMessagesApi(kind, instance, f.day), "claude-sonnet-5", {
        summary,
      }),
      mcp: new FakeMcp({ backend: f.backend, today: f.day.window }),
      ledger: new SpendLedger({
        store: new MemoryLedgerStore(),
        policy: {
          dailyCapUsd: "9",
          providers: { anthropic: { budgetUsd: "100", since: "2026-10-01T00:00:00Z" } },
        },
        now: () => new Date("2026-10-18T12:00:00Z"),
      }),
      seat: {
        ...standInSeat("solver", { id: modelId, provider: "anthropic" }),
        modelString: "claude-sonnet-5",
      },
      instance,
      window: f.day.window,
      daySha256: "d".repeat(64),
      sessionsDir: tmp,
      limits: { maxToolCalls: 6, maxTurns: 8 },
    });

  it("says what each model returned of its reasoning, and which sessions carry a flag", async () => {
    const asked = await run("researcher", "model-asked", true);
    const notAsked = await run("researcher", "model-not-asked", false);
    const lazy = await run("lazy", "model-lazy", true);
    const looper = await run("looper", "model-looper", true);
    const records = [asked.record, notAsked.record, lazy.record, looper.record];
    const { markdown, readings } = buildReasoningOverview(records, fileSessionLoader(), {
      window: f.day.window,
    });

    const flagsFor = (m: string): Flag[] => readings.find((x) => x.record.model === m)?.flags ?? [];
    expect(flagsFor("model-asked")).toEqual([]);
    expect(flagsFor("model-lazy")).toContain("no-data-read");
    expect(flagsFor("model-looper")).toEqual(
      expect.arrayContaining(["hit-limit", "repeated-call"]),
    );

    const row = (m: string) => markdown.split("\n").find((l) => l.startsWith(`| ${m} |`)) ?? "";
    expect(row("model-asked")).toContain("text returned in 1 of 1");
    expect(row("model-not-asked")).toContain("thinks; the text is not returned");
    expect(row("model-lazy")).toContain("none returned");
    expect(markdown).toContain("## Sessions with a flag");
    expect(markdown).toContain("model-lazy");
    expect(markdown).toContain("PRIVATE");
  });

  it("does not claim a session was clean when its transcript is missing, and says how many could not be checked", () => {
    const r = record({}, { session_file: join(tmp, "missing.json") });
    const { markdown } = buildReasoningOverview([r], fileSessionLoader(), { window: "2026-10-18" });
    expect(markdown).toContain("have no kept transcript");
  });

  it("covers snapshot mode and records written before the capture existed", () => {
    const snap = record({
      part: "snapshot",
      mcp: undefined,
      reasoning: {
        requested: "summary",
        turns_with_reasoning: 1,
        reasoning_chars: 40,
        redacted_blocks: 0,
        empty_blocks: 0,
        narration_turns: 0,
        narration_chars: 0,
      },
    });
    const old = record({ part: "snapshot", mcp: undefined, model: "m-old" });
    const { markdown } = buildReasoningOverview([snap, old], fileSessionLoader(), {
      window: "2026-10-18",
    });
    expect(markdown.split("\n").find((l) => l.startsWith("| m1 |"))).toContain(
      "text returned in 1 of 1",
    );
    expect(markdown.split("\n").find((l) => l.startsWith("| m-old |"))).toContain("not captured");
  });
});
