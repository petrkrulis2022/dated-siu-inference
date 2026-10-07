/**
 * What each agent decided and what it said about it, read from the model's own reply — never from anything the lab wrote about it.
 *
 * The optional `rationale` (and the friction fields) have been on every call since the gate runs (spec §7.4, §4.6aa): one line, in the
 * agent's own words, never required, never validated, never prompted for beyond one neutral sentence that is the same for every tool. They
 * were persisted, but only inside each turn's raw reply, which is local to the machine that ran it. This lifts them into the run's report,
 * beside the decision they accompanied, so asset choices can be read with their stated reasons across runs without re-reading transcripts.
 *
 * The raw reply is authoritative. A decision is read by the loop's own parser (`parseModelResponse`), so what counts as a call here is what
 * counted as one in the run; a reply that does not parse is not a decision and is left out (the run's refusals say it happened). A blank
 * rationale and no rationale are the same thing — absent — as in the loop's record.
 *
 * `rationaleCoverage` is the check the design asks for the first time this lands: if rationales turned up on payment turns and nowhere else,
 * that would be the emphasis effect (§4.6q on a new surface) and nothing read from them could be trusted. It compares how often a payment
 * carries one with how often every other call does.
 */
import { parseModelResponse } from "../loop/parse-tool-call.js";

/** The parts of a turn this reads: the model's raw reply and the prompt it answered. */
export interface TurnSource {
  turn: number;
  rawText?: string;
  promptText?: string;
}

export interface DecisionRecord {
  agentId: string;
  turn: number;
  /** The round the turn was taken in, read from the prompt's own header. */
  round?: number;
  /** The tool as the agent NAMED it (`pay_with_usdc`), or `wait` or `done`. */
  tool: string;
  requestId?: string;
  /** The agent's one line, if it wrote one. */
  rationale?: string;
  /** Friction fields that carry words, if any. */
  friction?: { conversion_reason?: string; missing_information?: string; could_not_express?: string };
}

const ROUND = /THE LAB — ROUND (\d+) OF/;

export function decisionsOf(turnsByAgent: Readonly<Record<string, readonly TurnSource[]>>): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  for (const [agentId, turns] of Object.entries(turnsByAgent)) {
    for (const t of turns) {
      if (t.rawText === undefined) continue;
      let intent;
      try {
        intent = parseModelResponse(t.rawText);
      } catch {
        continue; // not a decision: the loop could not read it either
      }
      const round = ROUND.exec(t.promptText ?? "")?.[1];
      const tool = "tool" in intent ? intent.tool : "wait" in intent ? "wait" : "done";
      const requestId = "tool" in intent ? (intent.args as { requestId?: unknown } | undefined)?.requestId : undefined;
      const f = intent.friction;
      const words = {
        ...(typeof f?.conversion_reason === "string" && f.conversion_reason.trim() !== "" ? { conversion_reason: f.conversion_reason.trim() } : {}),
        ...(typeof f?.missing_information === "string" && f.missing_information.trim() !== "" ? { missing_information: f.missing_information.trim() } : {}),
        ...(typeof f?.could_not_express === "string" && f.could_not_express.trim() !== "" ? { could_not_express: f.could_not_express.trim() } : {}),
      };
      out.push({
        agentId,
        turn: t.turn,
        ...(round !== undefined ? { round: Number(round) } : {}),
        tool,
        ...(typeof requestId === "string" ? { requestId } : {}),
        ...(intent.rationale !== undefined ? { rationale: intent.rationale } : {}),
        ...(Object.keys(words).length > 0 ? { friction: words } : {}),
      });
    }
  }
  return out;
}

/** A payment is any call that settles a quote, by the lab's names or the loop's. */
export const isPayment = (tool: string): boolean => /^pay/.test(tool) || tool === "transfer_claim" || tool === "settle_split" || tool === "settle_split_held";

export interface Coverage {
  calls: number;
  withRationale: number;
}

export interface RationaleCoverage {
  payments: Coverage;
  others: Coverage;
  byTool: Record<string, Coverage>;
  /** Payments carry a rationale at least this much more often than every other call: the emphasis effect, if there are enough calls to say. */
  emphasis: boolean;
}

/** How much more often a payment must carry a rationale than other calls, and how many of each, before the emphasis flag is raised. */
export const EMPHASIS_GAP = 0.2;
export const EMPHASIS_MIN_CALLS = 5;

export function rationaleCoverage(decisions: readonly DecisionRecord[]): RationaleCoverage {
  const payments: Coverage = { calls: 0, withRationale: 0 };
  const others: Coverage = { calls: 0, withRationale: 0 };
  const byTool: Record<string, Coverage> = {};
  for (const d of decisions) {
    const bucket = isPayment(d.tool) ? payments : others;
    bucket.calls += 1;
    if (d.rationale !== undefined) bucket.withRationale += 1;
    const t = (byTool[d.tool] ??= { calls: 0, withRationale: 0 });
    t.calls += 1;
    if (d.rationale !== undefined) t.withRationale += 1;
  }
  const rate = (c: Coverage): number => (c.calls === 0 ? 0 : c.withRationale / c.calls);
  const emphasis = payments.calls >= EMPHASIS_MIN_CALLS && others.calls >= EMPHASIS_MIN_CALLS && rate(payments) - rate(others) >= EMPHASIS_GAP;
  return { payments, others, byTool, emphasis };
}
