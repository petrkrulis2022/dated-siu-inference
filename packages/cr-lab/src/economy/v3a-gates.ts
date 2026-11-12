/**
 * v3a's validity gates (docs/experiment-3a-design.md, "Validity gates and freeze"), checked automatically from a run's own log: a counted run is scored only if it passes
 * every one, and a failed run is reported as invalid with its reason, never rerun quietly.
 *
 *  - Lost turns (parse or service failures): 1% or fewer.
 *  - Starting balances: every role holds both currencies at equal value, checked from the genesis holdings.
 *  - Board integrity: no paid or refunded quote appears as open on any board (checked against the log's own settlements, not the board's filter), and every refusal
 *    carries its reason (a refusal on a quote, need, offer or request names it first).
 *  - The scorer reads the seed from the log, never from the config default (D133); for a counted cell, the log's price-path seed hash must be the one frozen in the config.
 *  - Enough data is each measure's own rule (`v3a-measures.ts`): below its minimum count a measure reports n/a; that is not a gate on the run.
 */
import { asBigInt, type LogEntry } from "./log.js";
import type { EconomyParams } from "./params.js";
import { runMeta } from "./v3a-measures.js";

export interface Gate {
  name: string;
  ok: boolean;
  detail: string;
}

const SUBJECT_TOOLS = new Set(["accept_quote", "deliver_brief", "post_quote", "buy_offer", "withdraw_offer", "decline_request"]);
const SUBJECT = /^(?:quote|need|offer|request)-\d+: \S/;

export function checkGates(log: readonly LogEntry[], params: EconomyParams, opts: { cell?: string } = {}): Gate[] {
  const v = params.v3a;
  if (v === undefined) throw new Error("not a v3a parameters file");
  const gates: Gate[] = [];

  // lost turns
  const turns = log.filter((e) => e.kind === "turn" && e.mirror !== true);
  const parse = turns.filter((e) => e.parsed === false && e.serviceFailure === undefined).length;
  const service = turns.filter((e) => e.parsed === false && e.serviceFailure !== undefined).length;
  gates.push({
    name: "lost turns at most 1% (parse and service failures)",
    ok: turns.length > 0 && (parse + service) * 100 <= turns.length,
    detail: `${parse + service} of ${turns.length} lost (${parse} parse, ${service} service)`,
  });

  // starting balances
  const start = log.filter((e) => e.kind === "holdings" && e.atClose === 0);
  const bad: string[] = [];
  for (const e of start) {
    if (e.role === "provider") {
      if ((asBigInt(e.totalMicroSiu) ?? 0n) !== 0n) bad.push(`${e.actor} starts with value`);
      continue;
    }
    const want = e.role === "research" ? v.startingUsdc.research : e.role === "demand" ? v.startingUsdc.demand : v.startingUsdc.hedger;
    const usdc = asBigInt(e.usdc) ?? -1n;
    const agu = asBigInt(e.aguValueMicroUsd) ?? -1n;
    if (usdc !== want || agu - usdc > 1n || usdc - agu > 1n) bad.push(`${e.actor}: ${usdc} µ$ USDC, ${agu} µ$ of AGU-lab, ${want} expected`);
  }
  const roles = params.agents.research.length + params.agents.demand.length + 2;
  gates.push({
    name: "every role starts with both currencies at equal value",
    ok: start.length === roles && bad.length === 0,
    detail: bad.length === 0 ? `${start.length} wallets, each half USDC and half AGU-lab to within 1 µ$` : bad.join("; "),
  });

  // board integrity: a quote is settled at its first receipt or lapse entry, and is window-bound (an unaccepted one lapses unlogged at its window's close)
  const quoteDay = new Map<string, string>();
  const settledAt = new Map<string, number>();
  for (const e of log) {
    if (e.kind === "quote" && typeof e.quote === "string") quoteDay.set(e.quote, e.window);
    const q = e.kind === "receipt" && typeof e.brief === "string" ? e.brief : e.kind === "escrow-settle" && typeof e.quote === "string" ? e.quote : undefined;
    if (q !== undefined && !settledAt.has(q)) settledAt.set(q, e.seq);
  }
  const stale: string[] = [];
  for (const t of turns)
    for (const id of (t.boardQuotes as string[] | undefined) ?? []) {
      const s = settledAt.get(id);
      // settled at or before the last entry written before the board was drawn (`boardSeq`; a turn's own entry comes after its action)
      const drawnAfter = typeof t.boardSeq === "number" ? t.boardSeq : t.seq;
      if ((s !== undefined && s <= drawnAfter) || (quoteDay.has(id) && quoteDay.get(id) !== t.window)) stale.push(`${id} on ${t.actor}'s board at seq ${t.seq}`);
    }
  const unnamed = turns.filter(
    (e) =>
      e.parsed === true &&
      e.ok === false &&
      (typeof e.note !== "string" || e.note.trim() === "" || (SUBJECT_TOOLS.has(String(e.tool)) && !SUBJECT.test(e.note))),
  );
  gates.push({
    name: "board integrity: no settled quote shown as open; every refusal carries its reason",
    ok: stale.length === 0 && unnamed.length === 0 && turns.some((t) => t.boardQuotes !== undefined),
    detail: `${stale.length} stale quote(s)${stale.length > 0 ? ` (${stale.slice(0, 3).join("; ")})` : ""}; ${unnamed.length} refusal(s) without a named subject or reason${unnamed.length > 0 ? ` (${unnamed.slice(0, 3).map((e) => `seq ${e.seq} ${String(e.tool)}`).join("; ")})` : ""}`,
  });

  // seed from the log
  const meta = runMeta(log);
  const frozen = opts.cell === undefined ? undefined : v.printPath.seedHashes[opts.cell];
  gates.push({
    name: "the run's seed and price-path seed hash are read from its own log",
    ok: meta !== undefined && (opts.cell === undefined || (frozen !== undefined && frozen === meta.priceSeedHash)),
    detail:
      meta === undefined
        ? "no v3a genesis entry"
        : opts.cell === undefined
          ? `seed ${meta.seed}, arm ${meta.arm}, ${meta.volatility} volatility, path seed hash ${meta.priceSeedHash.slice(0, 12)}… (not a counted cell)`
          : `cell ${opts.cell}: path seed hash ${meta.priceSeedHash.slice(0, 12)}… ${frozen === meta.priceSeedHash ? "matches" : "does NOT match"} the frozen ${frozen?.slice(0, 12) ?? "(none frozen)"}`,
  });
  return gates;
}

export const gatesPass = (gates: readonly Gate[]): boolean => gates.every((g) => g.ok);
