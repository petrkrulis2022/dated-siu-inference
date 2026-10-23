/**
 * The MCP-mode gate (D101). The harness relays every tool result to the model, so the answer is graded against a key recomputed from exactly the data the model was given (its tool-call log),
 * not from a snapshot taken before or after: no refresh tolerance, no extra requests. A separate check then compares that key with the day's snapshot key, which catches a model that
 * fetched the wrong dataset, too little of it, or the wrong period. An answer passes only if it is right for the data it received AND that data gives the snapshot's answer.
 *
 * A tool result is JSON text in the MCP's own envelope (see `asDataApiBody`), which is put into the Data API's body shape so the same parser (`ingest`) reads a stored snapshot and a relayed result.
 */
import { Num, parseJsonDecimal, type Json } from "../data-desk/json-decimal.js";
import { gradeAnswer } from "../runner/grade.js";
import { referenceAnswerJson } from "../runner/prompts.js";
import { classify, type Classification } from "../runner/taxonomy.js";
import { emptyDay, finishDay, ingest, type DayData } from "../tasks/day-data.js";
import type { Verdict } from "../tasks/gates.js";
import type { Instance } from "../tasks/instances.js";
import { solvePL, solveSM, solveUO, solveVS } from "../tasks/solve.js";

/** One tool call as it was made and answered, the unit of the session's log. */
export interface RelayedCall {
  tool: string;
  args: Record<string, unknown>;
  isError: boolean;
  /** what the model was shown */
  text: string;
}

/**
 * The live MCP's data tools do NOT return the Data API's body (seen on the first live session, 2026-10-20, D116). A `timeseries_data` result is `{model, granularity, point_schema, series,
 * totalPoints}`, each series `{key, entity, points}` and each point `[time in seconds, value, ...]`; a `tabular_data` result is `{model, rows, totalRows, totalPages, page, pageSize}`. The
 * Data API wraps the same content in `data`. This puts a tool result into the body shape `ingest` reads, so a stored snapshot and a relayed result are parsed by the same code. Anything
 * else is returned as it is and, if it is not one of the datasets, adds nothing.
 */
export function asDataApiBody(tool: string, json: Json): Json {
  if (typeof json !== "object" || json === null || Array.isArray(json) || json instanceof Num)
    return json;
  const o = json as { [key: string]: Json };
  if (tool === "timeseries_data" && Array.isArray(o.series) && Array.isArray(o.point_schema))
    return { data: { point_schema: o.point_schema, series: o.series } };
  if (tool === "tabular_data" && Array.isArray(o.rows)) return { data: o.rows };
  return json;
}

/** A day built only from what the model received. A result that is an error, or not JSON, or not one of the datasets, adds nothing. */
export function dayFromRelayed(window: string, calls: readonly RelayedCall[]): DayData {
  const day = emptyDay(window);
  const seen = new Set<string>();
  for (const c of calls) {
    if (c.isError) continue;
    const model = c.args.model;
    if (typeof model !== "string" || !/^[A-Za-z0-9._~-]+$/.test(model)) continue;
    let path: string | undefined;
    if (c.tool === "timeseries_data") {
      // `granularity` is optional and defaults to 1d (the live tool description says so): a call that leaves it out is a daily read
      const granularity = c.args.granularity ?? "1d";
      if (typeof granularity === "string" && /^[A-Za-z0-9._~-]+$/.test(granularity))
        path = `/query/timeseries/${model}/${granularity}`;
    } else if (c.tool === "tabular_data") path = `/query/tabular/${model}`;
    if (path === undefined) continue;
    try {
      ingest(day, seen, { path }, asDataApiBody(c.tool, parseJsonDecimal(c.text)));
    } catch {
      /* not JSON: nothing to read */
    }
  }
  return finishDay(day, seen);
}

/** The key for an instance's question, computed from a given day; undefined when that day cannot answer it. */
export function referenceFor(instance: Instance, day: DayData): Instance["reference"] | undefined {
  switch (instance.task) {
    case "CR-VS":
      return solveVS(day, instance.params.endMonth, instance.params.months ?? 12);
    case "CR-PL":
      return solvePL(
        day,
        instance.params.protocolId,
        { start: instance.params.start, end: instance.params.end },
        // a model that reads only fees, interest and net interest income has read all the question needs (revenue is fees minus payouts)
        { deriveRevenue: true },
      );
    case "CR-UO":
      return solveUO(day, instance.params.slug);
    case "CR-SM":
      return solveSM(day, instance.params.dimension);
  }
}

/**
 * The last JSON object in a reply, as text, or undefined. A DIAGNOSTIC only: it shows whether a failed answer was only a failure of format (the model wrote its working before the answer).
 * The counted gate stays strict, as the question says: reply with the JSON object and nothing else.
 */
export function lastJsonObject(text: string): string | undefined {
  let last: string | undefined;
  let skipUntil = -1;
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    if (start < skipUntil) continue; // inside an object already found: only top-level objects count
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const v = JSON.parse(candidate) as unknown;
          if (typeof v === "object" && v !== null && !Array.isArray(v)) {
            last = candidate;
            skipUntil = i + 1;
          }
        } catch {
          /* not JSON: keep looking after this brace */
        }
        break;
      }
    }
  }
  return last;
}

export type SnapshotCheck = "same" | "differs" | "insufficient";

export interface McpGrade {
  passed: boolean;
  /** the answer against the key recomputed from the relayed data; absent if that key could not be computed */
  verdict?: Verdict;
  snapshotCheck: SnapshotCheck;
  classification: Classification;
  /** DIAGNOSTIC, never counted: would the answer pass if the last JSON object in the reply were read? Only worked out when the strict reading failed on format. */
  lenientPassed?: boolean;
}

/**
 * Grades an MCP-mode answer. `instance` carries the day's snapshot key. Reasons a run cannot pass: the data received cannot answer the question (`insufficient`), the answer is wrong for the
 * data received, or the key from the received data differs from the snapshot's beyond the gate's own tolerances (`differs`).
 */
export function gradeMcpAnswer(input: {
  instance: Instance;
  text: string;
  relayed: DayData;
  /** why the session ended on a limit, if it did */
  sessionLimit?: string;
  stopReason?: string;
}): McpGrade {
  const { instance, text } = input;
  const relayedKey = referenceFor(instance, input.relayed);
  let verdict: Verdict | undefined;
  let check: SnapshotCheck = "insufficient";
  if (relayedKey !== undefined) {
    const relayedInstance = { ...instance, reference: relayedKey } as Instance;
    verdict = text.trim() === "" ? undefined : gradeAnswer(relayedInstance, text);
    // is the key from the data the model received the same answer as the snapshot's, to the gate's tolerances?
    check = gradeAnswer(instance, referenceAnswerJson(relayedInstance)).passed ? "same" : "differs";
  }
  const passed = verdict?.passed === true && check === "same";
  const classification = classify({
    instance,
    text,
    ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
    ...(verdict !== undefined ? { verdict } : {}),
    ...(input.sessionLimit !== undefined ? { sessionLimit: input.sessionLimit } : {}),
    snapshotCheck: check,
  });
  let lenientPassed: boolean | undefined;
  if (
    !passed &&
    relayedKey !== undefined &&
    verdict?.failures.some((f) => f.code === "format") === true
  ) {
    const obj = lastJsonObject(text);
    lenientPassed =
      obj !== undefined &&
      check === "same" &&
      gradeAnswer({ ...instance, reference: relayedKey } as Instance, obj).passed;
  }
  return {
    passed,
    ...(verdict !== undefined ? { verdict } : {}),
    snapshotCheck: check,
    classification,
    ...(lenientPassed !== undefined ? { lenientPassed } : {}),
  };
}
