/**
 * What each trader's model returned of its own reasoning over a run, from the turn logs — a fact about the provider at the settings the
 * lab uses, and nothing about what the model did or did not think. The lab changes no setting to get more: no extended thinking is
 * switched on and no reasoning effort is changed (D52). A model that thinks privately and returns nothing of it shows as billed reasoning
 * tokens with no text, which is different from a model that bills none.
 */
import type { TurnLog } from "../loop/full-run.js";

export interface ThinkingCapture {
  model: string;
  /** Turns in which the model replied (a turn whose provider call failed has no reply). */
  turns: number;
  /** Turns whose response carried reasoning text. */
  turnsWithReasoningText: number;
  /** Reasoning tokens the provider billed over the run. */
  reasoningTokensBilled: number;
  /** Characters of reasoning text returned, before any cut. */
  reasoningCharsReturned: number;
}

export function thinkingCaptureOf(
  turnLogsByAgent: Readonly<Record<string, readonly Pick<TurnLog, "usage" | "thinking" | "rawText">[]>>,
  seatOf: Readonly<Record<string, string>>,
  models: Readonly<Record<string, string>>,
): Record<string, ThinkingCapture> {
  const out: Record<string, ThinkingCapture> = {};
  for (const [trader, seat] of Object.entries(seatOf)) {
    const logs = turnLogsByAgent[seat] ?? [];
    const replied = logs.filter((l) => l.rawText !== undefined);
    out[trader] = {
      model: models[trader] ?? "?",
      turns: replied.length,
      turnsWithReasoningText: replied.filter((l) => l.thinking !== undefined).length,
      reasoningTokensBilled: replied.reduce((s, l) => s + (l.usage?.reasoning ?? 0), 0),
      reasoningCharsReturned: replied.reduce((s, l) => s + (l.thinking?.length ?? 0), 0),
    };
  }
  return out;
}

/**
 * The sampling each trader's requests were actually sent with, over the run, from what the adapter reported (D59): the temperatures seen ("provider-default"
 * where none was sent) and how many turns reported nothing. A model that cannot take the temperature the lab asks for (claude-sonnet-5) shows
 * "provider-default" here, which is the record of what ran; the lab's stated 0.7 applies only where this says 0.7.
 */
export interface SamplingUsed {
  model: string;
  turns: number;
  temperatures: string[];
  turnsNotReported: number;
}

export function samplingOf(
  turnLogsByAgent: Readonly<Record<string, readonly Pick<TurnLog, "sent" | "rawText">[]>>,
  seatOf: Readonly<Record<string, string>>,
  models: Readonly<Record<string, string>>,
): Record<string, SamplingUsed> {
  const out: Record<string, SamplingUsed> = {};
  for (const [trader, seat] of Object.entries(seatOf)) {
    const replied = (turnLogsByAgent[seat] ?? []).filter((l) => l.rawText !== undefined);
    const temps = new Set<string>();
    let notReported = 0;
    for (const l of replied) {
      if (l.sent === undefined) notReported += 1;
      else temps.add(String(l.sent.temperature));
    }
    out[trader] = { model: models[trader] ?? "?", turns: replied.length, temperatures: [...temps].sort(), turnsNotReported: notReported };
  }
  return out;
}

/** One sentence per model: what was and was not captured. */
export function describeCapture(c: ThinkingCapture): string {
  if (c.turnsWithReasoningText > 0) {
    return `reasoning text returned on ${c.turnsWithReasoningText} of ${c.turns} turns (${c.reasoningCharsReturned} characters; ${c.reasoningTokensBilled} reasoning tokens billed)`;
  }
  if (c.reasoningTokensBilled > 0) {
    return `${c.reasoningTokensBilled} reasoning tokens billed over ${c.turns} turns and no reasoning text returned: the provider does not hand it back at the lab's settings`;
  }
  return `no reasoning text returned and no reasoning tokens billed over ${c.turns} turns`;
}
