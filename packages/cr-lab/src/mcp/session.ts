/**
 * One MCP-mode answer and one MCP-mode day (D101). A session is a research conversation (`runToolLoop`); its answer is graded from the data the model was shown and checked against the day's
 * snapshot (`gradeMcpAnswer`), then written as a record like any other answer: same fields, part `mcp`, plus the session's shape (turns, tool calls, the snapshot check). What the model was shown
 * is kept in a separate private file, because it is licensed data; the record names that file. A session the spend guard stopped is recorded as far as it got, then the stop is passed up.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { D, roundHalfUp } from "@touchstone/sdk";
import { PRIVATE_DIR, pathWithin, privatePath } from "../paths.js";
import { recordKey, type AnswerRecord, type RecordStore } from "../runner/records.js";
import type { Seat } from "../runner/run-answer.js";
import { SpendStopped, type SpendLedger } from "../spend/ledger.js";
import type { StopCode } from "../spend/check.js";
import type { DayData } from "../tasks/day-data.js";
import { drawInstances, type Instance, type TaskId } from "../tasks/instances.js";
import type { SeedBook } from "../tasks/seeds.js";
import {
  anthropicChat,
  runToolLoop,
  type LoopLimits,
  type MessagesApi,
  type SessionResult,
  type ToolChat,
} from "./anthropic-loop.js";
import { buildMcpPrompt } from "./prompts.js";
import { toMcpInstance } from "./variants.js";
import { dayFromRelayed, gradeMcpAnswer } from "./relayed.js";
import type { McpBackend } from "./types.js";

/** The tasks MCP mode runs for now: CR-UO waits for the live tool list, because where unlock schedules sit in the MCP's models is not known until the owner has signed in (D91). */
export const MCP_TASKS: readonly TaskId[] = ["CR-VS", "CR-PL", "CR-SM"];

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface RunMcpAnswerInput {
  /** the provider's chat for this seat; or, for Claude, just its Messages API */
  chat?: ToolChat;
  api?: MessagesApi;
  mcp: McpBackend;
  ledger: SpendLedger;
  seat: Seat;
  instance: Instance;
  window: string;
  daySha256: string;
  /** MCP mode's variant of the question, recorded with the session */
  variant?: string;
  limits?: Partial<LoopLimits>;
  /** where the session's relayed results are kept (private); defaults to the trial's private sessions directory */
  sessionsDir?: string;
  now?: () => Date;
}

export async function runMcpAnswer(
  input: RunMcpAnswerInput,
): Promise<{ record: AnswerRecord; stopped?: SpendStopped }> {
  const { seat, instance } = input;
  const chat =
    input.chat ??
    (input.api !== undefined && seat.provider === "anthropic"
      ? anthropicChat(input.api, seat.modelString)
      : undefined);
  if (chat === undefined)
    throw new Error(
      `no tool chat for ${seat.modelId}: give \`chat\`, or \`api\` for a Claude seat`,
    );
  if (chat.provider !== seat.provider)
    throw new Error(
      `the chat is for ${chat.provider} but ${seat.modelId} is served by ${seat.provider}`,
    );
  const now = input.now ?? (() => new Date());
  const prompt = buildMcpPrompt(instance, input.window);
  const session: SessionResult = await runToolLoop({
    chat,
    mcp: input.mcp,
    ledger: input.ledger,
    modelId: seat.modelId,
    keyName: seat.keyName,
    price: seat.price,
    prompt: prompt.text,
    what: instance.id,
    ...(input.limits !== undefined ? { limits: input.limits } : {}),
  });

  const relayedDay = dayFromRelayed(input.window, session.relayed);
  const grade = gradeMcpAnswer({
    instance,
    text: session.finalText,
    relayed: relayedDay,
    ...(session.limit !== undefined ? { sessionLimit: session.limit } : {}),
    ...(session.stopReason !== undefined ? { stopReason: session.stopReason } : {}),
  });
  const classes =
    session.error !== undefined
      ? ["call-failed" as const, ...grade.classification.classes.filter((c) => c !== "call-failed")]
      : grade.classification.classes;

  const dir = input.sessionsDir ?? privatePath("cr", "mcp-sessions", input.window);
  const file = pathWithin(dir, `${instance.id}__${seat.modelId}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ instance: instance.id, model: seat.modelId, prompt: prompt.text, relayed: session.relayed, final: session.finalText }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const record: AnswerRecord = {
    schema: 1,
    window: input.window,
    part: "mcp",
    task: instance.task,
    instance: instance.id,
    model: seat.modelId,
    provider: seat.provider,
    key: seat.keyName,
    at: now().toISOString(),
    data_sha256: sha(session.relayed.map((r) => r.text).join("\n")),
    prompt_sha256: prompt.promptSha256,
    day_sha256: input.daySha256,
    passed: grade.passed,
    fenced: grade.verdict?.fenced ?? false,
    ...(classes[0] !== undefined && !grade.passed ? { primary_failure: classes[0] } : {}),
    failure_classes: grade.passed ? [] : classes,
    failures: grade.verdict?.failures ?? [],
    usd: session.usd,
    tokens: {
      input: session.tokens.input,
      output: session.tokens.output,
      reasoning: 0,
      cached_input: 0,
    },
    latency_ms: session.latencyMs,
    ...(session.stopReason !== undefined ? { stop_reason: session.stopReason } : {}),
    deviations: [],
    ...(session.error !== undefined ? { error: session.error } : {}),
    raw_output: session.finalText,
    mcp: {
      ...(input.variant !== undefined ? { variant: input.variant } : {}),
      ...(grade.lenientPassed !== undefined ? { lenient_passed: grade.lenientPassed } : {}),
      snapshot_check: grade.snapshotCheck,
      ...(session.limit !== undefined ? { limit: session.limit } : {}),
      tools_offered: session.toolsOffered,
      tools_withheld: session.toolsWithheld,
      turns: session.turns.map((t) => ({ ...t })),
      tool_calls: session.toolCalls.map((c) => ({
        turn: c.turn,
        tool: c.tool,
        args: c.args,
        is_error: c.isError,
        result_bytes: c.result_bytes,
        latency_ms: c.latency_ms,
      })),
      session_file: relative(PRIVATE_DIR, file).startsWith("..")
        ? file
        : relative(PRIVATE_DIR, file),
    },
  };
  return { record, ...(session.stopped !== undefined ? { stopped: session.stopped } : {}) };
}

export interface RunMcpDayInput {
  window: string;
  /** the day's snapshot data: the instances are drawn from it and carry its keys */
  day: DayData;
  daySha256: string;
  seats: readonly Seat[];
  ledger: SpendLedger;
  seeds: SeedBook;
  records: RecordStore;
  mcp: McpBackend;
  /** the chat for a seat (its provider, its trial key) */
  chatFor?: (seat: Seat) => ToolChat;
  /** for Claude seats only: the Messages API for a seat (its trial key) */
  apiFor?: (seat: Seat) => MessagesApi;
  /** instances per task, default 1 (D101: eight sessions a day to start) */
  perTask?: number;
  tasks?: readonly TaskId[];
  limits?: Partial<LoopLimits>;
  sessionsDir?: string;
  maxSessions?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface RunMcpDaySummary {
  window: string;
  planned: number;
  alreadyRecorded: number;
  attempted: number;
  passed: number;
  usd: string;
  stopped?: { code: StopCode; reason: string; provider: string };
  complete: boolean;
}

export async function runMcpDay(input: RunMcpDayInput): Promise<RunMcpDaySummary> {
  const log = input.log ?? (() => undefined);
  input.seeds.commit(input.window);
  const seed = input.seeds.seedFor(input.window);
  const tasks = input.tasks ?? MCP_TASKS;
  // MCP mode asks its own version of a question where it has one (the volume question over three months, D105)
  const variants = new Map<string, string>();
  const instances: Instance[] = [];
  for (const drawn of drawInstances(input.day, seed, input.perTask ?? 1).filter((i) =>
    tasks.includes(i.task),
  )) {
    const v = toMcpInstance(drawn, input.day);
    if (v === undefined) continue;
    instances.push(v.instance);
    if (v.variant !== undefined) variants.set(v.instance.id, v.variant);
  }
  const done = new Set(
    input.records
      .forWindow(input.window)
      .filter((r) => r.part === "mcp")
      .map(recordKey),
  );
  const jobs: { instance: Instance; seat: Seat }[] = [];
  for (const instance of instances)
    for (const seat of input.seats)
      if (!done.has(recordKey({ instance: instance.id, model: seat.modelId })))
        jobs.push({ instance, seat });
  const planned = instances.length * input.seats.length;
  const alreadyRecorded = planned - jobs.length;
  log(
    `window ${input.window}, MCP mode: ${planned} sessions planned, ${alreadyRecorded} already recorded, ${jobs.length} to run`,
  );

  let attempted = 0;
  let passed = 0;
  let spent = new D(0);
  let stopped: RunMcpDaySummary["stopped"];
  for (const job of jobs) {
    if (input.maxSessions !== undefined && attempted >= input.maxSessions) break;
    const out = await runMcpAnswer({
      ...(input.chatFor !== undefined
        ? { chat: input.chatFor(job.seat) }
        : input.apiFor !== undefined
          ? { api: input.apiFor(job.seat) }
          : {}),
      mcp: input.mcp,
      ledger: input.ledger,
      seat: job.seat,
      instance: job.instance,
      ...(variants.has(job.instance.id)
        ? { variant: variants.get(job.instance.id) as string }
        : {}),
      window: input.window,
      daySha256: input.daySha256,
      ...(input.limits !== undefined ? { limits: input.limits } : {}),
      ...(input.sessionsDir !== undefined ? { sessionsDir: input.sessionsDir } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    input.records.append(out.record);
    attempted += 1;
    if (out.record.passed) passed += 1;
    spent = spent.plus(out.record.usd);
    log(
      `${out.record.passed ? "pass" : "FAIL"} ${job.instance.id} ${job.seat.modelId} $${roundHalfUp(new D(out.record.usd), 4)} (${out.record.mcp?.tool_calls.length ?? 0} tool calls)${out.record.primary_failure !== undefined ? ` (${out.record.primary_failure})` : ""}`,
    );
    if (out.stopped !== undefined) {
      stopped = {
        code: out.stopped.code,
        reason: out.stopped.reason,
        provider: out.stopped.provider,
      };
      log(`STOPPED by the spend guard: ${out.stopped.message}`);
      break;
    }
  }
  return {
    window: input.window,
    planned,
    alreadyRecorded,
    attempted,
    passed,
    usd: spent.toFixed(),
    ...(stopped !== undefined ? { stopped } : {}),
    complete: stopped === undefined && alreadyRecorded + attempted === planned,
  };
}
