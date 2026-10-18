/**
 * The ordered record of one research session (D107): what the model said it was doing, what reasoning the provider returned, each tool call it made, the size of each result, and how the
 * session ended, in the order they happened. It exists so a person can read why an agent searched, gave up or answered, which the answer and the call counts alone cannot say.
 *
 * It holds only what the provider returned and what the loop did. Reasoning text is the provider's own (a summary, full text, or nothing: `runner/reasoning.ts` says what each provider
 * offers); narration is the visible text a model wrote beside a tool call. Nothing is asked of the model beyond what the task prompt already asks, and no model setting is changed for it.
 * Tool results are not repeated here (the session file keeps them once, in `relayed`, because the grader needs them): a result appears as its size and whether it failed.
 * The transcript is private. Reasoning can restate the licensed figures a model was shown, so it stays in the private directory and is never committed.
 */
import type { ReasoningRequest } from "../runner/reasoning.js";
import type { ReasoningStats } from "../runner/records.js";

export type TranscriptEvent =
  | {
      turn: number;
      kind: "reasoning";
      text: string;
      redacted_blocks: number;
      empty_blocks: number;
    }
  | { turn: number; kind: "narration"; text: string }
  | { turn: number; kind: "tool_call"; tool: string; args: Record<string, unknown> }
  | { turn: number; kind: "tool_result"; tool: string; is_error: boolean; result_bytes: number }
  | { turn: number; kind: "final"; text: string }
  | { turn: number; kind: "end"; limit?: string; error?: string };

/** Counted from the transcript, so the numbers and the text they describe cannot disagree. */
export function reasoningStats(
  transcript: readonly TranscriptEvent[],
  requested: ReasoningRequest,
): ReasoningStats {
  const stats: ReasoningStats = {
    requested,
    turns_with_reasoning: 0,
    reasoning_chars: 0,
    redacted_blocks: 0,
    empty_blocks: 0,
    narration_turns: 0,
    narration_chars: 0,
  };
  for (const e of transcript) {
    if (e.kind === "reasoning") {
      if (e.text !== "") stats.turns_with_reasoning += 1;
      stats.reasoning_chars += e.text.length;
      stats.redacted_blocks += e.redacted_blocks;
      stats.empty_blocks += e.empty_blocks;
    } else if (e.kind === "narration") {
      stats.narration_turns += 1;
      stats.narration_chars += e.text.length;
    }
  }
  return stats;
}
