import { TOOLS } from "../tools/index.js";
import type { FrictionLogEntry } from "./log.js";

export interface MissingToolReport {
  agent: string;
  turn: number;
  tool: string;
  text: string;
  /**
   * True when the run deliberately withheld this tool from this agent — the non-serving issuer
   * is supposed to have no `serve_redemption`, and says so every window.
   *
   * It is reported, never dropped: a disclosed absence is still the reason an agent could not
   * act, and silently filtering it is how the first detector went wrong. But it must not be
   * counted as a defect. Widening the phrasing regex (§4.6x) took the corpus from 12 grant
   * problems to 27, of which 26 were the non-serving issuer behaving exactly as designed — a
   * banner crying wolf 26 times, with the one real entry (WORKER-EXTRACT's `redeem_claim`,
   * runs 9 and 10) buried in it. That is the same drowning this detector exists to prevent.
   */
  byDesign: boolean;
}

/** `agent:tool` pairs the run intends to withhold — see `MissingToolReport.byDesign`. */
export type WithheldByDesign = ReadonlySet<string>;

/**
 * Friction entries in which an agent named a TOOL IT DID NOT HAVE.
 *
 * This exists because the field already worked and nobody read it. WORKER-EXTRACT was paid in
 * fSIU in runs 9 and 10 while holding no claim tool at all, both claims expired worthless, and
 * its own friction log said so at the time:
 *
 *     "redeem_claim is not in the list of available tools this turn"
 *
 * The run report printed the path to that file and nothing else, so the entry sat unread through
 * two runs and contaminated the second purchase in both — fSIU was strictly worse than dollars
 * for a recipient that could not redeem it, which is not a preference anyone chose between.
 *
 * A `could_not_express` naming a missing TOOL is a different severity from one naming a missing
 * workflow step. "No idle/wait primitive" is a design gap to consider; "redeem_claim is not
 * available" means an agent was handed an asset it could not use, and every measurement
 * involving that agent is suspect until it is fixed. They are separated here so the second can
 * never again be read as an instance of the first.
 */
export function missingToolFrictions(
  entries: FrictionLogEntry[],
  withheldByDesign: WithheldByDesign = new Set(),
): MissingToolReport[] {
  const toolNames = Object.keys(TOOLS);
  const out: MissingToolReport[] = [];
  for (const e of entries) {
    const text = e.could_not_express;
    if (!text) continue;
    // A tool name plus any phrasing of "I was not given it". Deliberately broad on the phrasing
    // and strict on the tool name: a false positive costs a line in a report, and a false
    // negative costs a run.
    //
    // Widened 2026-10-01 (spec §4.6x). The original required the words "not in the list of",
    // "not listed", "not among" or "not available" more or less adjacent, and real agents do not
    // write that way. The corpus scan found five live phrasings it missed — "is not in YOUR
    // AVAILABLE TOOLS THIS TURN", "not in this turn's listed tool set", "not in this turn's tool
    // list" — every one a named, existing tool reported absent, every one filed as the quieter
    // kind. The gap between "not" and the denial word is now allowed to carry a few words.
    //
    // Precision still comes from the tool-name gate below, not from this regex, which is why
    // widening it is safe. What it must NOT do is start matching phrasings that merely mention a
    // tool while describing a different gap ("no idle/wait tool; polling get_print", "cannot
    // submit_job and quote_forward in the same turn") — those are capability gaps and belong to
    // the other detector. Both are pinned by test.
    const denied =
      /\bunavailable\b|\bdo(?:es)?\s+not\s+have\b|\bno\s+access\s+to\b|\bnot\b[^.;]{0,40}?\b(?:available|granted|listed|in the list|tool list|tool set)\b/i;
    if (!denied.test(text)) {
      continue;
    }
    const named = toolNames.find((t) => text.includes(t));
    if (named === undefined) continue;
    out.push({
      agent: e.agent,
      turn: e.turn,
      tool: named,
      text,
      byDesign: withheldByDesign.has(`${e.agent}:${named}`),
    });
  }
  return out;
}

export interface CapabilityGapReport {
  agent: string;
  turn: number;
  text: string;
}

/**
 * Every OTHER `could_not_express` — an agent saying it could not do something, where no tool it
 * already has would have let it.
 *
 * `missingToolFrictions` answers "was this agent denied a tool that EXISTS?" — a grant problem,
 * and the louder of the two. It cannot answer "did this agent need a capability nobody built?",
 * because it requires the text to name a known tool, and the name of a tool that does not exist
 * is not in `TOOLS`. For two runs that was a gap nobody had hit. Run 13 hit it:
 *
 *     "No tool exists to check whether the issuer has actually served the redeemed claim"
 *
 * WORKER-CODE had redeemed a claim and wanted to confirm delivery. Nothing does that, so it
 * called `get_balances` nine times as the nearest proxy, bought nothing in three windows, and
 * read from the outside as a buyer declining to buy. That entry matched neither the phrasing
 * regex ("No tool exists" is not "not available") nor any tool name, so the run report printed
 * no banner and the run's loudest finding sat in a JSONL file — exactly the failure
 * `missingToolFrictions` was written to end, one level up.
 *
 * Deliberately unfiltered: every non-null `could_not_express` that is not already a grant
 * problem is returned. Judging which gaps are "real" is what hid this one. A false positive
 * costs a line in a report; a false negative costs a measurement nobody knows is broken.
 */
export function capabilityGapFrictions(
  entries: FrictionLogEntry[],
  withheldByDesign: WithheldByDesign = new Set(),
): CapabilityGapReport[] {
  const grantProblems = new Set(
    missingToolFrictions(entries, withheldByDesign).map((m) => `${m.agent}:${m.turn}`),
  );
  const out: CapabilityGapReport[] = [];
  for (const e of entries) {
    const text = e.could_not_express;
    if (!text) continue;
    if (grantProblems.has(`${e.agent}:${e.turn}`)) continue;
    out.push({ agent: e.agent, turn: e.turn, text });
  }
  return out;
}
