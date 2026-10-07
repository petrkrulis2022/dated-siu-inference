/**
 * Waits taken while there was something to do (D34), read from the turn logs: the prompt each turn answered and what
 * the turn did. A wait is a turn whose call was `{"wait": true}`; "something it could do" is what the loop itself
 * counts as a reason to wake an agent — a need it can buy, a job it owes, a request addressed to it, a quote it was
 * sent and has not paid. Those sections are rendered only when non-empty, so their heading in a prompt is the evidence.
 *
 * The record exists because two gpt-5.4-mini traders stalled in the first two runs with items on their screens, and
 * "did it wait with work in front of it" was then answered by reading prompts by hand. It is a fact about a turn and
 * says nothing about why the agent waited.
 */
import type { TurnLog } from "../loop/full-run.js";

/** The headings a prompt carries only while there is something to act on, and what each is. */
const ACTIONABLE: readonly { what: string; heading: RegExp }[] = [
  { what: "a need to buy, a job owed, or raw work to buy", heading: /^OPEN FOR YOU NOW$/m },
  { what: "a request addressed to it", heading: /^Open quote requests addressed to you/m },
  { what: "a quote it was sent and has not paid", heading: /^Quotes you have received/m },
];

export interface WaitRecord {
  agentId: string;
  turn: number;
  /** What was on the screen it waited on; empty if nothing was. */
  hadWork: string[];
}

export function waitsOf(turnLogsByAgent: Readonly<Record<string, readonly TurnLog[]>>): WaitRecord[] {
  const out: WaitRecord[] = [];
  for (const [agentId, logs] of Object.entries(turnLogsByAgent)) {
    for (const l of logs) {
      if (!/^\{"wait":\s*true/.test(l.parsed)) continue;
      const prompt = l.promptText ?? "";
      out.push({ agentId, turn: l.turn, hadWork: ACTIONABLE.filter((a) => a.heading.test(prompt)).map((a) => a.what) });
    }
  }
  return out;
}

/** Waits that had something to do, per agent. */
export function waitedWithWork(waits: readonly WaitRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of waits) if (w.hadWork.length > 0) out[w.agentId] = (out[w.agentId] ?? 0) + 1;
  return out;
}
