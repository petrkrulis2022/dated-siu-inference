/**
 * Passages of agent reasoning (D107): the units a person tags. One passage is a reasoning block or a piece of narration in an MCP session's transcript, or the reasoning text a snapshot-mode
 * answer returned. Each carries what the masking needs: the texts the agent was shown, so figures that came from the licensed data can be hidden.
 */
import type { AnswerRecord } from "../runner/records.js";
import type { SessionLoader } from "./overview.js";

/** A passage shorter than this says too little to tag. */
export const MIN_PASSAGE_CHARS = 30;

export interface Passage {
  /** where it came from: instance, model, and the turn and kind within the session; unique within a window */
  key: string;
  window: string;
  model: string;
  instance: string;
  /** the passage as the agent produced it (private) */
  text: string;
  /** the texts the agent was shown, for masking; empty where they were not kept */
  shown: string[];
}

export function passagesFromRecords(
  records: readonly AnswerRecord[],
  load: SessionLoader,
): Passage[] {
  const out: Passage[] = [];
  for (const r of records) {
    const base = { window: r.window, model: r.model, instance: r.instance };
    const id = `${r.instance}::${r.model}`;
    if (r.part === "mcp") {
      const s = load(r);
      const shown = s === undefined ? [] : [s.prompt, ...s.relayed.map((c) => c.text)];
      for (const [i, e] of (s?.transcript ?? []).entries())
        if (
          (e.kind === "reasoning" || e.kind === "narration") &&
          e.text.trim().length >= MIN_PASSAGE_CHARS
        )
          out.push({
            ...base,
            key: `${r.window}|${id}#${e.turn}:${e.kind}:${i}`,
            text: e.text,
            shown,
          });
    } else if ((r.reasoning_text ?? "").trim().length >= MIN_PASSAGE_CHARS)
      out.push({
        ...base,
        key: `${r.window}|${id}#snapshot:reasoning`,
        text: r.reasoning_text as string,
        shown: [],
      });
  }
  return out;
}
