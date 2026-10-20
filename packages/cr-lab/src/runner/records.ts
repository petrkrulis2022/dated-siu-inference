/**
 * One record per answer (§16.7), appended to a JSONL file per window under the private directory: the raw reply can restate Blockworks' figures, so the whole file is private
 * and the committed tree never sees it. A record carries what the daily reconciliation against each provider's per-key usage needs (the key's name, never its value) and what the
 * tables need (the verdict, the class, the billed cost). A window's file is append-only; the runner skips an (instance, model) pair already recorded, so a stopped run resumes.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Provider } from "../keys.js";
import { assertWindowAndTag } from "../data-desk/snapshots.js";
import { pathWithin, privatePath } from "../paths.js";
import type { Part } from "../spend/types.js";
import type { Failure } from "../tasks/gates.js";
import type { TaskId } from "../tasks/instances.js";
import type { ReasoningRequest } from "./reasoning.js";
import type { FailureClass } from "./taxonomy.js";

export interface AnswerRecord {
  schema: 1;
  window: string;
  part: Extract<Part, "snapshot" | "dry-run" | "mcp">;
  task: TaskId;
  instance: string;
  model: string;
  provider: Provider;
  /** the `.env` name of the key that paid */
  key: string;
  at: string;
  /** sha256 of the figures shown, of the whole prompt, and of the day's snapshot set */
  data_sha256: string;
  prompt_sha256: string;
  day_sha256: string;
  passed: boolean;
  /** the reply was in a fenced block: noted, not a failure */
  fenced: boolean;
  primary_failure?: FailureClass;
  failure_classes: FailureClass[];
  failures: Failure[];
  /** billed cost in USD, an exact decimal string; "0" when the call failed before billing */
  usd: string;
  tokens: { input: number; output: number; reasoning: number; cached_input: number };
  latency_ms: number;
  stop_reason?: string;
  deviations: string[];
  /** a sanitised reason when the call failed (error class and HTTP status only, never a message body) */
  error?: string;
  /** the output allowance this call ran under, in tokens (D113). Absent on a record written before the rule, which ran under the print's allowance. */
  allowance_tokens?: number;
  /** the model's raw reply, private */
  raw_output: string;
  /**
   * What the provider returned of the model's reasoning, as the provider returned it (D107). Absent on a record written before reasoning was captured, which is not the same as
   * "none returned": a record with this field and `turns_with_reasoning: 0` says the provider returned none.
   */
  reasoning?: ReasoningStats;
  /** Snapshot mode only: the reasoning text itself, private like `raw_output`. In MCP mode the ordered transcript, reasoning included, is in the session file. */
  reasoning_text?: string;
  /** MCP mode only: the shape of the research session behind the answer (the tool results themselves are in `session_file`, privately) */
  mcp?: McpSessionSummary;
}

/** The text side of a model's reasoning in one answer, counted from what the provider returned (never from a judgement of it). */
export interface ReasoningStats {
  /** what was asked of the provider about reasoning in this answer: its summary (Sonnet, D107) or nothing, the provider's defaults */
  requested: ReasoningRequest;
  /** turns (one in snapshot mode) on which the provider returned reasoning text */
  turns_with_reasoning: number;
  reasoning_chars: number;
  /** `redacted_thinking` blocks: returned by the provider, not readable */
  redacted_blocks: number;
  /** thinking blocks returned with no text: the model thought and the text was not offered */
  empty_blocks: number;
  /** turns on which the model wrote visible text alongside a tool call (MCP mode: what it said about what it was doing) */
  narration_turns: number;
  narration_chars: number;
}

export interface McpSessionSummary {
  /** MCP mode's own version of the question, if it differs from snapshot mode's (D105) */
  variant?: string;
  /** DIAGNOSTIC, never counted: a failed answer that would pass if the last JSON object in the reply were read (a failure of format only) */
  lenient_passed?: boolean;
  /** the key recomputed from the data the model received, against the day's snapshot key */
  snapshot_check: "same" | "differs" | "insufficient";
  /** why the session ended before an answer, if it did */
  limit?: string;
  tools_offered: string[];
  tools_withheld: string[];
  turns: {
    turn: number;
    input_tokens: number;
    output_tokens: number;
    usd: string;
    stop_reason?: string;
    latency_ms: number;
    retries: number;
    reasoning_tokens?: number;
  }[];
  tool_calls: {
    turn: number;
    tool: string;
    args: Record<string, unknown>;
    is_error: boolean;
    result_bytes: number;
    latency_ms: number;
  }[];
  /** where what the model was shown is kept, relative to the private directory */
  session_file: string;
}

export interface RecordStore {
  append(rec: AnswerRecord): void;
  /** every record of a window, in the order written */
  forWindow(window: string): AnswerRecord[];
  /** every window that has a file, ascending */
  windows(): string[];
}

export class FileRecordStore implements RecordStore {
  readonly #dir: string;

  constructor(dir?: string) {
    this.#dir = dir ?? privatePath("cr", "records");
  }

  #file(window: string): string {
    assertWindowAndTag(window, "daily");
    return pathWithin(this.#dir, `${window}.jsonl`);
  }

  append(rec: AnswerRecord): void {
    const f = this.#file(rec.window);
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  }

  forWindow(window: string): AnswerRecord[] {
    const f = this.#file(window);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as AnswerRecord);
  }

  windows(): string[] {
    if (!existsSync(this.#dir)) return [];
    return readdirSync(this.#dir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .map((n) => n.slice(0, 10))
      .sort();
  }
}

export class MemoryRecordStore implements RecordStore {
  readonly #rows: AnswerRecord[] = [];
  append(rec: AnswerRecord): void {
    this.#rows.push(structuredClone(rec));
  }
  forWindow(window: string): AnswerRecord[] {
    return this.#rows.filter((r) => r.window === window).map((r) => structuredClone(r));
  }
  windows(): string[] {
    return [...new Set(this.#rows.map((r) => r.window))].sort();
  }
}

/** Where the tables are written: private, beside the records. */
export const tablesDir = (...segments: string[]): string =>
  privatePath("cr", "tables", ...segments);

/** The identity of an attempt: one instance, one model. A window has at most one record per key (§16.7: no retries). */
export const recordKey = (r: Pick<AnswerRecord, "instance" | "model">): string =>
  `${r.instance}::${r.model}`;
