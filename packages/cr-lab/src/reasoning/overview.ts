/**
 * The daily reasoning overview (D107): for one window, what each model returned of its reasoning, and which sessions carry an objective flag. It is the monitoring half of the reasoning
 * requirement, the counterpart of the lab's run overview; it exists so a person reads why agents searched, gave up or answered, not only whether they passed.
 *
 * Every flag is a rule applied to the logs and says so in `FLAG_RULES`. None judges the reasoning, and no model is asked to (invariant 6: no judge models). A flag is a prompt to read, not a
 * finding: "figure-not-in-data" in particular means the figure is in no tool result and not in the prompt, so the agent computed it or made it up, and only reading says which.
 * The overview is private: reasoning can restate the licensed figures an agent was shown, so it is written to the private directory and never committed.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { lastJsonObject, type RelayedCall } from "../mcp/relayed.js";
import type { TranscriptEvent } from "../mcp/transcript.js";
import { PRIVATE_DIR } from "../paths.js";
import { cutForReading } from "../runner/reasoning.js";
import type { AnswerRecord } from "../runner/records.js";
import { DataFigures, ungroundedFigures } from "./figures.js";

/** What an MCP session file holds (`mcp/session.ts` writes it). */
export interface SessionFile {
  instance: string;
  model: string;
  prompt: string;
  relayed: RelayedCall[];
  final: string;
  reasoning_requested?: string;
  /** absent in a session file written before D107 */
  transcript?: TranscriptEvent[];
}

export type SessionLoader = (record: AnswerRecord) => SessionFile | undefined;

/** Reads the session file a record names, relative to the private directory unless absolute. */
export const fileSessionLoader =
  (privateDir: string = PRIVATE_DIR): SessionLoader =>
  (record) => {
    const p = record.mcp?.session_file;
    if (p === undefined) return undefined;
    const file = isAbsolute(p) ? p : join(privateDir, p);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf-8")) as SessionFile;
    } catch {
      return undefined;
    }
  };

export const FLAGS = [
  "no-data-read",
  "error-then-answered",
  "repeated-call",
  "format-only-failure",
  "hit-limit",
  "placeholder-values",
  "figure-not-in-data",
  "read-too-little",
] as const;
export type Flag = (typeof FLAGS)[number];

export const FLAG_RULES: Readonly<Record<Flag, string>> = {
  "no-data-read": "gave a final answer although no data-tool call succeeded",
  "error-then-answered": "the last tool result before the final answer was an error",
  "repeated-call": "made the same tool call, with the same arguments, more than once",
  "format-only-failure":
    "failed, and would have passed had the last JSON object in the reply been read: prose came before the answer",
  "hit-limit":
    "the session ended on a limit (turns, tool calls, size, spend) rather than on an answer",
  "placeholder-values":
    "failed with a final JSON of three or more numeric values that are all identical",
  "figure-not-in-data":
    "reasoning or narration states a figure of four significant digits or more that is in no tool result, not in the prompt, and not in the agent's own final answer (those are graded against the key): computed along the way, or invented",
  "read-too-little":
    "gave a final answer although the data it read could not answer the question (the key could not be recomputed from it), or its answer fits a smaller dataset than the key",
};

export interface SessionReading {
  record: AnswerRecord;
  flags: Flag[];
  /** the figures behind `figure-not-in-data`, as written */
  ungrounded: string[];
  /** a session file was found and had a transcript */
  transcriptKept: boolean;
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : x,
  );

/** The numeric leaves of a JSON value: numbers, and strings that are plain decimals. */
function numericLeaves(v: unknown): string[] {
  if (typeof v === "number") return [String(v)];
  if (typeof v === "string") return /^-?\d+(?:\.\d+)?$/.test(v.trim()) ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(numericLeaves);
  if (v !== null && typeof v === "object")
    return Object.values(v as Record<string, unknown>).flatMap(numericLeaves);
  return [];
}

function isPlaceholder(final: string): boolean {
  const json = lastJsonObject(final);
  if (json === undefined) return false;
  try {
    const leaves = numericLeaves(JSON.parse(json));
    return leaves.length >= 3 && new Set(leaves).size === 1;
  } catch {
    return false;
  }
}

/** Applies the flag rules to one MCP session. Only MCP sessions have the logs the rules need. */
export function readSession(
  record: AnswerRecord,
  session: SessionFile | undefined,
): SessionReading {
  const flags: Flag[] = [];
  let ungrounded: string[] = [];
  const final = session?.final ?? record.raw_output;
  const answered = final.trim() !== "" && record.error === undefined;
  const relayed = session?.relayed ?? [];
  if (record.part === "mcp" && session !== undefined) {
    if (answered && relayed.every((c) => c.isError)) flags.push("no-data-read");
    if (answered && relayed.length > 0 && relayed[relayed.length - 1]?.isError === true)
      flags.push("error-then-answered");
    const seen = new Set<string>();
    if (
      relayed.some((c) =>
        seen.has(`${c.tool}${stable(c.args)}`)
          ? true
          : (seen.add(`${c.tool}${stable(c.args)}`), false),
      )
    )
      flags.push("repeated-call");
    if (!record.passed && record.mcp?.lenient_passed === true) flags.push("format-only-failure");
    if (record.mcp?.limit !== undefined) flags.push("hit-limit");
    if (!record.passed && answered && isPlaceholder(final)) flags.push("placeholder-values");
    if (
      answered &&
      (record.mcp?.snapshot_check === "insufficient" ||
        record.failure_classes.includes("wrong-dataset"))
    )
      flags.push("read-too-little");
    if (session.transcript !== undefined) {
      const said = session.transcript
        .filter((e) => e.kind === "reasoning" || e.kind === "narration")
        .map((e) => e.text)
        .join("\n");
      // the final answer's own figures are graded against the key, so a figure the agent computed and then answered is not unverified; one it computed and did not answer, or stated and never used, is
      const shown = new DataFigures([session.prompt, ...relayed.map((c) => c.text), final]);
      ungrounded = ungroundedFigures(said, shown).map(
        (f) => f.token + (f.scale !== undefined ? ` ${f.scale}` : ""),
      );
      if (ungrounded.length > 0) flags.push("figure-not-in-data");
    }
  }
  flags.sort((a, b) => FLAGS.indexOf(a) - FLAGS.indexOf(b));
  return { record, flags, ungrounded, transcriptKept: session?.transcript !== undefined };
}

/** Reasoning tokens a record's provider reported billing, or undefined if it reported none either way. */
function reasoningTokens(r: AnswerRecord): number | undefined {
  if (r.part === "mcp") {
    const turns = r.mcp?.turns ?? [];
    return turns.some((t) => t.reasoning_tokens !== undefined)
      ? turns.reduce((a, t) => a + (t.reasoning_tokens ?? 0), 0)
      : undefined;
  }
  return r.tokens.reasoning;
}

interface Coverage {
  model: string;
  part: string;
  answers: number;
  requested: string;
  withText: number;
  emptyBlocks: number;
  redacted: number;
  withNarration: number;
  tokens: number;
  tokensReported: boolean;
  uncaptured: number;
}

function coverageOf(records: readonly AnswerRecord[]): Coverage[] {
  const by = new Map<string, Coverage>();
  for (const r of records) {
    const k = `${r.model}|${r.part}`;
    const c =
      by.get(k) ??
      ({
        model: r.model,
        part: r.part,
        answers: 0,
        requested: "",
        withText: 0,
        emptyBlocks: 0,
        redacted: 0,
        withNarration: 0,
        tokens: 0,
        tokensReported: false,
        uncaptured: 0,
      } satisfies Coverage);
    c.answers += 1;
    if (r.reasoning === undefined) c.uncaptured += 1;
    else {
      if (r.reasoning.turns_with_reasoning > 0) c.withText += 1;
      c.emptyBlocks += r.reasoning.empty_blocks;
      c.redacted += r.reasoning.redacted_blocks;
      if (r.reasoning.narration_turns > 0) c.withNarration += 1;
      if (!c.requested.split("/").includes(r.reasoning.requested))
        c.requested =
          c.requested === "" ? r.reasoning.requested : `${c.requested}/${r.reasoning.requested}`;
    }
    const t = reasoningTokens(r);
    if (t !== undefined) {
      c.tokens += t;
      c.tokensReported = true;
    }
    by.set(k, c);
  }
  return [...by.values()].sort((a, b) => (a.model + a.part).localeCompare(b.model + b.part));
}

/** What a reader should take from a model's coverage row: none returned is not the same as none happening. */
function readingOf(c: Coverage): string {
  if (c.uncaptured === c.answers) return "not captured (records written before D107)";
  if (c.withText > 0) return `text returned in ${c.withText} of ${c.answers}`;
  if (c.emptyBlocks > 0 || c.redacted > 0 || c.tokens > 0)
    return "thinks; the text is not returned";
  if (c.tokensReported) return "no reasoning reported";
  return "none returned; whether it thinks is not reported";
}

const cell = (s: string | number): string => String(s).replace(/\|/g, "\\|");

export interface Overview {
  markdown: string;
  readings: SessionReading[];
}

export function buildReasoningOverview(
  records: readonly AnswerRecord[],
  load: SessionLoader,
  opts: { window: string },
): Overview {
  const readings = records.map((r) => readSession(r, r.part === "mcp" ? load(r) : undefined));
  const cov = coverageOf(records);
  const lines: string[] = [];
  lines.push(`# Reasoning overview: window ${opts.window}`, "");
  lines.push(
    "PRIVATE. Reasoning can restate the licensed figures an agent was shown, so this file stays in the private directory and is never committed or published.",
    "",
    "What is measured: what each provider returned of each model's reasoning, and what the model said beside its tool calls. The flags are rules applied to the logs (below); none judges the reasoning, and no model reads another model's reasoning. A flag is a prompt to read the session, not a finding.",
    "",
  );
  lines.push("## What each model returned of its reasoning", "");
  lines.push(
    "| model | mode | answers | asked for | text returned in | thinking blocks, no text | redacted | narration in | reasoning tokens billed | reading |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const c of cov)
    lines.push(
      `| ${cell(c.model)} | ${c.part} | ${c.answers} | ${c.requested === "" ? "-" : c.requested} | ${c.withText} | ${c.emptyBlocks} | ${c.redacted} | ${c.withNarration} | ${c.tokensReported ? c.tokens : "not reported"} | ${readingOf(c)} |`,
    );
  lines.push("");

  const mcp = readings.filter((x) => x.record.part === "mcp");
  lines.push("## Flags by model (MCP mode)", "");
  if (mcp.length === 0) lines.push("No MCP-mode sessions in this window.", "");
  else {
    lines.push(`| model | sessions | ${FLAGS.join(" | ")} |`);
    lines.push(`|---|---|${FLAGS.map(() => "---").join("|")}|`);
    for (const model of [...new Set(mcp.map((x) => x.record.model))].sort()) {
      const mine = mcp.filter((x) => x.record.model === model);
      lines.push(
        `| ${cell(model)} | ${mine.length} | ${FLAGS.map((f) => mine.filter((x) => x.flags.includes(f)).length).join(" | ")} |`,
      );
    }
    lines.push("", "The rules:", "");
    for (const f of FLAGS) lines.push(`- **${f}**: ${FLAG_RULES[f]}.`);
    lines.push("");
    const noTranscript = mcp.filter((x) => !x.transcriptKept).length;
    if (noTranscript > 0)
      lines.push(
        `${noTranscript} of ${mcp.length} sessions have no kept transcript (session file missing or written before D107), so the figure rule could not be applied to them.`,
        "",
      );
  }

  const flagged = mcp.filter((x) => x.flags.length > 0);
  lines.push("## Sessions with a flag", "");
  if (flagged.length === 0) lines.push("None.", "");
  for (const x of flagged) {
    const r = x.record;
    const session = load(r);
    lines.push(
      `### ${r.instance} · ${r.model} · ${r.passed ? "passed" : `failed${r.primary_failure !== undefined ? ` (${r.primary_failure})` : ""}`}`,
      "",
    );
    lines.push(
      `Flags: ${x.flags.join(", ")}. ${r.mcp?.tool_calls.length ?? 0} tool calls, ${r.mcp?.turns.length ?? 0} turns${r.mcp?.limit !== undefined ? `, ended on ${r.mcp.limit}` : ""}.`,
      "",
    );
    if (x.ungrounded.length > 0)
      lines.push(
        `Figures in the reasoning or narration that are in no tool result: ${x.ungrounded.slice(0, 8).join(", ")}${x.ungrounded.length > 8 ? ", …" : ""}.`,
        "",
      );
    for (const e of session?.transcript ?? []) {
      if (e.kind === "reasoning" && e.text !== "")
        lines.push(`- turn ${e.turn} reasoning: ${cutForReading(e.text, 600).replace(/\n/g, " ")}`);
      else if (e.kind === "narration")
        lines.push(`- turn ${e.turn} said: ${cutForReading(e.text, 400).replace(/\n/g, " ")}`);
      else if (e.kind === "tool_call")
        lines.push(
          `- turn ${e.turn} called ${e.tool} ${cutForReading(JSON.stringify(e.args), 160)}`,
        );
      else if (e.kind === "tool_result")
        lines.push(`  - ${e.is_error ? "ERROR, " : ""}${e.result_bytes} bytes`);
      else if (e.kind === "final")
        lines.push(`- turn ${e.turn} answered: ${cutForReading(e.text, 300).replace(/\n/g, " ")}`);
      else if (e.kind === "end" && (e.limit !== undefined || e.error !== undefined))
        lines.push(`- ended: ${e.limit ?? e.error}`);
    }
    if ((session?.transcript ?? []).length === 0)
      lines.push("- no kept transcript for this session");
    lines.push("", `Session file (private): \`${r.mcp?.session_file ?? "none"}\``, "");
  }
  return { markdown: `${lines.join("\n")}\n`, readings };
}
