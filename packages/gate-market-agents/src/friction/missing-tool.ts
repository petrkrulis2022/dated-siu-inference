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
