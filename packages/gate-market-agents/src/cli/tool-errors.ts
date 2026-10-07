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

const ARGS_MARKER = " -> args error: ";
const REFUSED_MARKER = " -> tool call error: ";

/**
 * Every call an agent made that was refused BEFORE it ran — an argument the tool would not take, a lab guard's refusal
 * (a quote that is not theirs, a payment the wallet cannot cover, a name the agent was not given) — as a record. These
 * are not tool errors: nothing reached a tool. They were only in the log, so "did any call fail on format" meant reading
 * scrollback; the first rerun's answer had to be counted by hand. Separated into `format` (the call itself was malformed:
 * not parseable, not a tool, wrong arguments) and `refused` (a well-formed call the lab declined), which are different
 * findings.
 */
export function refusalsOf(
  turnLogsByAgent: Readonly<Record<string, readonly TurnLog[]>>,
): { agentId: string; turn: number; kind: "format" | "refused"; sentence: string }[] {
  const out: { agentId: string; turn: number; kind: "format" | "refused"; sentence: string }[] = [];
  for (const [agentId, logs] of Object.entries(turnLogsByAgent)) {
    for (const l of logs) {
      if (l.parsed.startsWith("Unparseable model response")) {
        out.push({ agentId, turn: l.turn, kind: "format", sentence: l.parsed.slice(0, 200) });
        continue;
      }
      const at = l.parsed.indexOf(ARGS_MARKER);
      if (at !== -1) {
        const sentence = l.parsed.slice(at + ARGS_MARKER.length);
        // Lab guards and the payment check speak in whole sentences about the lab; a tool's own argument complaint names
        // the tool or a field. The first are refusals, the second a malformed call.
        const refused = /^(This payment costs|you |a job |a unit |raw work |there is no quote|the claim part|qr-\d+ )/.test(sentence);
        out.push({ agentId, turn: l.turn, kind: refused ? "refused" : "format", sentence });
        continue;
      }
      // A call by a name the agent was not given is refused before it runs, and so carries no `toolCall` mark.
      if (l.toolCall === undefined) {
        const r = l.parsed.indexOf(REFUSED_MARKER);
        if (r !== -1) out.push({ agentId, turn: l.turn, kind: "format", sentence: l.parsed.slice(r + REFUSED_MARKER.length) });
      }
    }
  }
  return out;
}
