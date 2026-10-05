import type { TurnLog } from "../loop/full-run.js";

const MARKER = " -> tool call error: ";

/**
 * Every tool call in a window that errored, as a record rather than a line in a log nobody
 * re-reads. The loop already marks each turn's call `ok` or not and writes the error an agent was
 * shown into the turn's `parsed` text; this lifts the two together into the report, so that a
 * scripted walk can state "no tool call errored" from the artefact instead of from scrollback, and a
 * real run's reader can see at a glance which calls reverted.
 */
export function toolErrorsOf(
  turnLogsByAgent: Readonly<Record<string, readonly TurnLog[]>>,
): { agentId: string; turn: number; tool: string; error: string }[] {
  const out: { agentId: string; turn: number; tool: string; error: string }[] = [];
  for (const [agentId, logs] of Object.entries(turnLogsByAgent)) {
    for (const l of logs) {
      if (l.toolCall === undefined || l.toolCall.ok) continue;
      const at = l.parsed.indexOf(MARKER);
      out.push({
        agentId,
        turn: l.turn,
        tool: l.toolCall.name,
        error: at === -1 ? l.parsed : l.parsed.slice(at + MARKER.length),
      });
    }
  }
  return out;
}
