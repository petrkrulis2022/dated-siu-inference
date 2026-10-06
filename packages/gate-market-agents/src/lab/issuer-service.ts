/**
 * ISSUER-B as an automatic service (plan D3): a deterministic policy that answers requests for raw work and
 * releases the escrows it is paid through. No model is called and nothing is decided — it does what an
 * issuer selling a standing product does, on ISSUER-B's own key and through the same tools, the same board
 * and the same loop as every other seat.
 *
 * It reads the same structured sections a trader's prompt carries, with the readers the scripted policy also
 * uses (`cues/prompt-cues.ts`). One action per turn; whatever is left stays on the board and wakes it again.
 *
 * What it does NOT do is serve a claim. Raw work paid in fSIU arrives as a keyed transfer of a claim to the
 * issuer, which the lab credits when the payment is recorded; the issuer simply holds the claim, and it
 * expires with the window like any other (plan D8).
 */
import type { Adapter, AdapterResult } from "@touchstone/harness";
import { openRequests, owedInUsdc } from "../cues/prompt-cues.js";
import { historyOf } from "./lab-cues.js";
import type { ToolName } from "../tools/index.js";

/** The only tools the service needs. */
export const ISSUER_SERVICE_TOOLS: readonly ToolName[] = ["issue_quote", "settle_escrow"];

const free = (intent: unknown): AdapterResult => ({
  text: JSON.stringify(intent),
  stopReason: "end_turn",
  usage: { input: 0, output: 0, cached_input: 0, reasoning: 0 },
  latency_ms: 0,
  raw: {},
  deviations: [],
});

/** A release the chain has refused this many times is not tried again: a service that repeats it burns its turns. */
export const MAX_SETTLE_ATTEMPTS = 2;

/** Answers the first open request, else releases the first paid escrow, else waits. */
export function issuerServiceAdapter(): Adapter {
  return async (_model, prompt) => {
    const open = openRequests(prompt);
    if (open.length > 0) return free({ tool: "issue_quote", args: { requestId: open[0].requestId } });
    // Found by a fork walk (2026-10-06): one escrow the contract refused to release was retried every turn, so the
    // service spent its whole budget on it. Failed calls are in its history (spec §4.6bj); it reads them.
    const history = historyOf(prompt);
    const refused = (id: string): number =>
      history.filter((c) => c.tool === "settle_escrow" && c.failed && c.args.requestId === id).length;
    const owed = owedInUsdc(prompt).filter((id) => refused(id) < MAX_SETTLE_ATTEMPTS);
    if (owed.length > 0) return free({ tool: "settle_escrow", args: { requestId: owed[0] } });
    return free({ wait: true });
  };
}
