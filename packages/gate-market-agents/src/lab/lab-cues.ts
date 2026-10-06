/**
 * Readers of what a lab trader is shown: its brief, the lab's action section, the board and its own history.
 * Used by the scripted traders (a debug mode) — a seat decides from the text of its own prompt, exactly as a
 * model does, never from a side channel into the loop. Each reader anchors on a header at the start of a
 * line, so a tool description or a history line quoting the same words cannot match, and each is tested
 * against the lab's and the loop's own renderers (`lab-cues.test.ts`): a change to what traders are shown
 * that the scripts cannot read fails a test instead of silently stalling a walk.
 */
import { sectionLines } from "../cues/prompt-cues.js";
import { LAB_TRADERS, type TraderLabel } from "./economy.js";

export type Counterparty = TraderLabel | "ISSUER-B";

/** `YOU ARE TRADER-2.` — the one fact that tells a script which seat it is acting as. */
export function whoAmI(prompt: string): TraderLabel | undefined {
  const m = /^YOU ARE (TRADER-[1-4])\./m.exec(prompt);
  return m ? (m[1] as TraderLabel) : undefined;
}

export function myAddress(prompt: string): string | undefined {
  return /^\s+YOUR ADDRESS: (0x[0-9a-fA-F]{40})/m.exec(prompt)?.[1];
}

/** The fSIU every trader holds: `tokenId 777,` in the brief's THE FSIU IN THIS LAB. */
export function claimTokenId(prompt: string): string | undefined {
  return /All fSIU here is one token: tokenId (\d+),/.exec(prompt)?.[1];
}

/** `THE TRADERS` — the sellerId and model a quote request needs, for every counterparty. */
export function directoryOf(prompt: string): Partial<Record<Counterparty, { sellerId: string; model: string }>> {
  const out: Partial<Record<Counterparty, { sellerId: string; model: string }>> = {};
  for (const line of sectionLines(prompt, /^THE TRADERS$/)) {
    const m = /^\s+(TRADER-[1-4]|ISSUER-B):(?: skill \S+;)? sellerId "([^"]+)"; model "([^"]+)"/.exec(line);
    if (m) out[m[1] as Counterparty] = { sellerId: m[2], model: m[3] };
  }
  return out;
}

/** `Needs you can buy now:` — `TRADER-1#1: TYPE-2 from TRADER-3 (round 1)`. */
export function openNeeds(prompt: string): { needId: string; type: string; seller: TraderLabel; round: number }[] {
  return sectionLines(prompt, /^Needs you can buy now:/)
    .map((l) => /^\s+(TRADER-[1-4]#\d+): (TYPE-\d) from (TRADER-[1-4]) \(round (\d+)\)/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ needId: m[1], type: m[2], seller: m[3] as TraderLabel, round: Number(m[4]) }));
}

/** `Jobs you have been paid for and have not delivered (you hold N unit(s) of raw work):`. */
export function owedJobs(prompt: string): { requestId: string; type: string; buyer: TraderLabel }[] {
  return sectionLines(prompt, /^Jobs you have been paid for and have not delivered/)
    .map((l) => /^\s+(qr-\d+): (\S+) for (TRADER-[1-4])/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ requestId: m[1], type: m[2], buyer: m[3] as TraderLabel }));
}

/** The units of raw work held, from the same header. Undefined when there is no such section. */
export function unitsHeld(prompt: string): number | undefined {
  const m = /^Jobs you have been paid for and have not delivered \(you hold (\d+) units? of raw work\):/m.exec(prompt);
  return m ? Number(m[1]) : undefined;
}

/** `Quotes you have received` with the amount each carries — what a buyer may now pay. */
export function receivedQuotes(prompt: string): { requestId: string; sellerId: string; amountUsd: string }[] {
  return sectionLines(prompt, /^Quotes you have received/)
    .map((l) => /^\s+(qr-\d+): quote from seller (\S+?), amount_usd_max (\S+?),/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ requestId: m[1], sellerId: m[2], amountUsd: m[3] }));
}

/** One call in the history block, in the loop's own format: `Turn N — called tool({args}) -> {result}`. */
export interface HistoryCall {
  turn: number;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  failed: boolean;
}

export function historyOf(prompt: string): HistoryCall[] {
  const start = prompt.indexOf("WHAT HAS HAPPENED SO FAR:");
  if (start < 0) return [];
  const calls: HistoryCall[] = [];
  for (const line of prompt.slice(start).split("\n")) {
    const m = /^Turn (\d+) — called ([a-z_]+)\((.*)\) -> (.*)$/.exec(line);
    if (!m) continue;
    try {
      const result = JSON.parse(m[4]);
      calls.push({
        turn: Number(m[1]),
        tool: m[2],
        args: JSON.parse(m[3]) as Record<string, unknown>,
        result,
        failed: typeof result === "object" && result !== null && "error" in (result as object),
      });
    } catch {
      // A line that is not one of ours is not a call.
    }
  }
  return calls;
}

/** The requests whose job this trader has delivered, from its own history. */
export function deliveredIn(history: readonly HistoryCall[]): Set<string> {
  return new Set(
    history
      .filter((c) => c.tool === "deliver_job" && !c.failed && (c.result as { delivered?: unknown }).delivered === true)
      .map((c) => String(c.args.requestId)),
  );
}

export const isTrader = (label: string): label is TraderLabel => (LAB_TRADERS as readonly string[]).includes(label);
