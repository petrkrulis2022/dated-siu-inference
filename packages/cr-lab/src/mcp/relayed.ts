/**
 * The MCP-mode gate (D101). The harness relays every tool result to the model, so the answer is graded against a key recomputed from exactly the data the model was given (its tool-call log),
 * not from a snapshot taken before or after: no refresh tolerance, no extra requests. A separate check then compares that key with the day's snapshot key, which catches a model that
 * fetched the wrong dataset, too little of it, or the wrong period. An answer passes only if it is right for the data it received AND that data gives the snapshot's answer.
 *
 * Assumption to confirm on the first live sign-in: a tool result is the Data API's JSON body as text, so the same parser (`ingest`) reads a stored snapshot and a relayed result.
 */
import { parseJsonDecimal } from "../data-desk/json-decimal.js";
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

/** A day built only from what the model received. A result that is an error, or not JSON, or not one of the datasets, adds nothing. */
export function dayFromRelayed(window: string, calls: readonly RelayedCall[]): DayData {
  const day = emptyDay(window);
  const seen = new Set<string>();
  for (const c of calls) {
    if (c.isError) continue;
    const model = c.args.model;
    if (typeof model !== "string" || !/^[A-Za-z0-9._~-]+$/.test(model)) continue;
    let path: string | undefined;
    if (c.tool === "timeseries_data" && typeof c.args.granularity === "string")
      path = /^[A-Za-z0-9._~-]+$/.test(c.args.granularity)
        ? `/query/timeseries/${model}/${c.args.granularity}`
        : undefined;
    else if (c.tool === "tabular_data") path = `/query/tabular/${model}`;
    if (path === undefined) continue;
    try {
      ingest(day, seen, { path }, parseJsonDecimal(c.text));
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
      return solvePL(day, instance.params.protocolId, {
        start: instance.params.start,
        end: instance.params.end,
      });
    case "CR-UO":
      return solveUO(day, instance.params.slug);
    case "CR-SM":
      return solveSM(day, instance.params.dimension);
  }
}

export type SnapshotCheck = "same" | "differs" | "insufficient";

export interface McpGrade {
  passed: boolean;
  /** the answer against the key recomputed from the relayed data; absent if that key could not be computed */
  verdict?: Verdict;
  snapshotCheck: SnapshotCheck;
  classification: Classification;
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
  return {
    passed,
    ...(verdict !== undefined ? { verdict } : {}),
    snapshotCheck: check,
    classification,
  };
}
