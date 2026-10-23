/**
 * The Haiku probe (D117): is claude-haiku-4-5's 0 of 24 on CR-VS, CR-PL and CR-SM a statement about the model, or about how the harness asks? Snapshot mode asks for a single JSON object with no
 * working, and runs Sonnet with adaptive thinking on (D107) and Haiku with none, so Haiku is the only model asked to do the arithmetic in its head. The probe gives Haiku scratch space in two
 * ways, one at a time, on the SAME instances and the SAME prompts as the counted run, and changes nothing else:
 *
 *  - `working-field`: the prompt's one reply instruction asks for a `working` string first, then the answer fields. The `working` field is removed (text only, figures untouched) before the
 *    unchanged gate reads the reply.
 *  - `thinking`: the prompt is the counted prompt; the call enables extended thinking with a budget of the task's frozen allowance less 2,000 tokens (never under 1,024), and sends no temperature.
 *
 * One attempt per instance per condition, the frozen allowances (D113), a hard cap on the money, no retries. Probe records never enter the counted records or tables.
 */
import { createHash } from "node:crypto";
import type { Adapter, AdapterParams } from "@touchstone/harness";
import { D } from "@touchstone/sdk";
import {
  Num,
  parseJsonDecimal,
  stringifyJsonDecimal,
  type Json,
} from "../data-desk/json-decimal.js";
import { gradeAnswer } from "../runner/grade.js";
import type { PromptBundle } from "../runner/prompts.js";
import type { AnswerRecord } from "../runner/records.js";
import { runAnswer, type Seat } from "../runner/run-answer.js";
import { classify } from "../runner/taxonomy.js";
import type { SpendLedger } from "../spend/ledger.js";
import type { Instance } from "../tasks/instances.js";

export const PROBE_CAP_USD = "2.00";
export type Condition = "working-field" | "thinking";
export const CONDITIONS: readonly Condition[] = ["working-field", "thinking"];

/** The counted prompt's reply instruction, and what it becomes under `working-field`. Nothing else in the prompt changes. */
export const REPLY_LINE =
  "Reply with a single JSON object and nothing else: no explanation before or after it.";
export const WORKING_LINE =
  'Reply with a single JSON object and nothing else: no explanation before or after it. The object has a first field "working", a string in which you write out your calculation step by step, and then the answer fields exactly as the schema below gives them.';

export function workingFieldPrompt(text: string): string {
  if (!text.includes(REPLY_LINE))
    throw new Error("the prompt does not hold the reply instruction the probe replaces");
  return text.replace(REPLY_LINE, WORKING_LINE);
}

/**
 * Removes a top-level string `working` field from a reply, as text, leaving every figure as it was written (numbers are kept as their source text). The reply is read exactly as the gate
 * reads it, including a fenced reply (the fence is kept, so a fenced answer is still flagged fenced, as in the counted run). A reply that is not a JSON object, or has no such field, is returned
 * unchanged, so the gate sees exactly what the model wrote.
 */
export function stripWorking(text: string): string {
  const trimmed = text.trim();
  // the gate's own fence pattern (`parseAnswer`)
  const fence = /^```([A-Za-z]*)\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (fence !== null) {
    const inner = stripWorkingObject((fence[2] as string).trim());
    return inner === undefined ? text : `\`\`\`${fence[1] as string}\n${inner}\n\`\`\``;
  }
  return stripWorkingObject(trimmed) ?? text;
}

/** The object as text without its `working` string, or undefined if it is not a JSON object with one. */
function stripWorkingObject(body: string): string | undefined {
  if (!body.startsWith("{")) return undefined;
  let parsed: Json;
  try {
    parsed = parseJsonDecimal(body);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    parsed instanceof Num
  )
    return undefined;
  const obj = parsed as { [key: string]: Json };
  if (typeof obj.working !== "string") return undefined;
  const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "working"));
  return stringifyJsonDecimal(rest);
}

/**
 * Re-reads a stored `working-field` reply with the current `stripWorking`, with no new call: for a row whose first grade was made by a stripping that did not read the reply as the gate does.
 * The row keeps its cost and tokens; the grade, classes and failures are those of the same reply read correctly, and a deviation says so.
 */
export function regradeWorkingRow(row: ProbeRow, instance: Instance, reply: string): ProbeRow {
  const text = stripWorking(reply);
  const verdict = text.trim() === "" ? undefined : gradeAnswer(instance, text);
  const cls = classify({
    instance,
    text,
    ...(row.record.stop_reason !== undefined ? { stopReason: row.record.stop_reason } : {}),
    ...(verdict !== undefined ? { verdict } : {}),
  });
  const rest: AnswerRecord = { ...row.record };
  delete rest.primary_failure;
  return {
    condition: row.condition,
    record: {
      ...rest,
      passed: verdict?.passed === true,
      fenced: verdict?.fenced ?? false,
      ...(cls.primary !== undefined ? { primary_failure: cls.primary } : {}),
      failure_classes: cls.classes,
      failures: verdict?.failures ?? [],
      raw_output: text,
      deviations: [
        ...row.record.deviations,
        "regraded offline from the stored reply: the first grade was made by a stripping of the working field that did not read a fenced reply as the gate does; same reply, no new call",
      ],
    },
  };
}

/** The thinking budget of `thinking`: the task's allowance less 2,000 tokens for the answer, never under the API's minimum of 1,024. */
export const thinkingBudget = (allowance: number): number => Math.max(1024, allowance - 2000);

export interface ProbeItem {
  instance: Instance;
  bundle: PromptBundle;
  window: string;
  daySha256: string;
}

export interface ProbeRow {
  condition: Condition;
  record: AnswerRecord;
}

export interface ProbeResult {
  rows: ProbeRow[];
  spentUsd: string;
  /** set when the next call was not made because the cap would have been passed */
  capReached: boolean;
}

export interface RunProbeInput {
  seat: Seat;
  ledger: SpendLedger;
  items: readonly ProbeItem[];
  allowances: Readonly<Record<Instance["task"], number>>;
  capUsd?: string;
  /** conditions already run, as `<condition>|<instance id>`: never run twice (one attempt each, and a run that stopped is resumed, not repeated) */
  done?: ReadonlySet<string>;
  /** called with the model's whole reply before the working is removed, to keep it privately */
  keepReply?: (condition: Condition, instance: Instance, text: string) => void;
  log?: (line: string) => void;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Runs both conditions on each item, one item after the other (the two conditions of an item back to back), so that a cap that stops the run leaves the two conditions with the same
 * instances. Before each ITEM the run checks that the money spent so far, plus three times the dearest single call seen so far (two calls, one and a half times over), is inside the cap.
 */
export async function runProbe(input: RunProbeInput): Promise<ProbeResult> {
  const log = input.log ?? (() => undefined);
  const cap = new D(input.capUsd ?? PROBE_CAP_USD);
  const rows: ProbeRow[] = [];
  let spent = new D(0);
  let dearest = new D("0.05");
  const done = input.done ?? new Set<string>();
  for (const item of input.items) {
    if (CONDITIONS.every((c) => done.has(`${c}|${item.instance.id}`))) continue;
    // room for BOTH conditions of the item, so that a stop on the cap never leaves one condition with an instance the other did not get
    if (spent.plus(dearest.times("3")).gt(cap)) {
      log(
        `cap: $${spent.toFixed(4)} spent of $${cap.toFixed(2)}, the next two calls could pass it: stopping`,
      );
      return { rows, spentUsd: spent.toFixed(), capReached: true };
    }
    for (const condition of CONDITIONS) {
      if (done.has(`${condition}|${item.instance.id}`)) continue;
      const keep = (text: string) => input.keepReply?.(condition, item.instance, text);
      // the seat for this condition: the counted seat with one change
      const base = input.seat;
      const adapter: Adapter =
        condition === "working-field"
          ? async (modelString, prompt, params) => {
              const res = await base.adapter(modelString, prompt, params);
              keep(res.text);
              return { ...res, text: stripWorking(res.text) };
            }
          : base.adapter;
      const params: AdapterParams =
        condition === "thinking"
          ? {
              ...base.params,
              omit_temperature: true,
              thinking: {
                mode: "manual",
                budget_tokens: thinkingBudget(input.allowances[item.instance.task]),
              },
            }
          : base.params;
      const bundle: PromptBundle =
        condition === "working-field"
          ? (() => {
              const text = workingFieldPrompt(item.bundle.text);
              return {
                ...item.bundle,
                text,
                promptSha256: sha(text),
                approxTokens: Math.max(1, Math.ceil(text.length / 4)),
              };
            })()
          : item.bundle;
      const record = await runAnswer({
        ledger: tagged(input.ledger, `probe-${condition}`),
        seat: { ...base, adapter, params },
        instance: item.instance,
        bundle,
        window: item.window,
        daySha256: item.daySha256,
        part: "dry-run",
        allowances: input.allowances,
      });
      if (condition === "thinking") keep(record.raw_output);
      rows.push({ condition, record });
      const usd = new D(record.usd);
      spent = spent.plus(usd);
      if (usd.gt(dearest)) dearest = usd;
      log(
        `${condition.padEnd(13)} ${item.instance.id} ${record.passed ? "pass" : "FAIL"} $${usd.toFixed(4)}${record.primary_failure !== undefined && !record.passed ? ` (${record.primary_failure})` : ""}`,
      );
    }
  }
  return { rows, spentUsd: spent.toFixed(), capReached: false };
}

/** The ledger as the answer runner uses it, with the probe's condition added to what each call is booked against, so a probe's spend is never mistaken for a counted answer's. */
function tagged(ledger: SpendLedger, tag: string): SpendLedger {
  return {
    guard: (
      provider: Parameters<SpendLedger["guard"]>[0],
      projected: string,
      meta: { what: string } & Record<string, unknown>,
      fn: () => Promise<unknown>,
    ) =>
      ledger.guard(
        provider,
        projected,
        { ...meta, what: `${meta.what}#${tag}` } as never,
        fn as never,
      ),
  } as unknown as SpendLedger;
}

export interface Tally {
  condition: Condition | "control";
  answers: number;
  passed: number;
  usd: string;
  classes: Record<string, number>;
}

export function tally(condition: Tally["condition"], records: readonly AnswerRecord[]): Tally {
  const classes: Record<string, number> = {};
  let usd = new D(0);
  for (const r of records) {
    usd = usd.plus(r.usd);
    if (!r.passed)
      for (const c of r.failure_classes.slice(0, 1)) classes[c] = (classes[c] ?? 0) + 1;
  }
  return {
    condition,
    answers: records.length,
    passed: records.filter((r) => r.passed).length,
    usd: usd.toFixed(),
    classes,
  };
}

/**
 * How the result will be read, fixed before the run. With `n` answers per condition: if BOTH conditions pass at least half, the 0 of 24 is mainly the absence of working space (and the harness
 * gave Sonnet some and Haiku none); if NEITHER passes more than a sixth, the low score on this basket is the model's; anything else is partial and is reported as such.
 */
export function readResult(
  n: number,
  passed: { workingField: number; thinking: number },
): "working-space" | "capability" | "partial" {
  if (passed.workingField * 2 >= n && passed.thinking * 2 >= n) return "working-space";
  if (passed.workingField * 6 <= n && passed.thinking * 6 <= n) return "capability";
  return "partial";
}
