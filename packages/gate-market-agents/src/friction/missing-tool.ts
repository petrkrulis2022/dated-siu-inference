import { TOOLS } from "../tools/index.js";
import type { FrictionLogEntry } from "./log.js";

export interface MissingToolReport {
  agent: string;
  turn: number;
  tool: string;
  text: string;
}

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
export function missingToolFrictions(entries: FrictionLogEntry[]): MissingToolReport[] {
  const toolNames = Object.keys(TOOLS);
  const out: MissingToolReport[] = [];
  for (const e of entries) {
    const text = e.could_not_express;
    if (!text) continue;
    // A tool name plus any phrasing of "I was not given it". Deliberately broad on the phrasing
    // and strict on the tool name: a false positive costs a line in a report, and a false
    // negative costs a run.
    if (!/not (in the list of|listed|among|available)|unavailable|do(es)? not have|was not granted/i.test(text)) {
      continue;
    }
    const named = toolNames.find((t) => text.includes(t));
    if (named === undefined) continue;
    out.push({ agent: e.agent, turn: e.turn, tool: named, text });
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
export function capabilityGapFrictions(entries: FrictionLogEntry[]): CapabilityGapReport[] {
  const grantProblems = new Set(missingToolFrictions(entries).map((m) => `${m.agent}:${m.turn}`));
  const out: CapabilityGapReport[] = [];
  for (const e of entries) {
    const text = e.could_not_express;
    if (!text) continue;
    if (grantProblems.has(`${e.agent}:${e.turn}`)) continue;
    out.push({ agent: e.agent, turn: e.turn, text });
  }
  return out;
}
