/**
 * ISSUER-B as an automatic service (plan D3): a deterministic policy that answers requests for raw work. No model is
 * called and nothing is decided — it does what an issuer selling a standing product does, on ISSUER-B's own key and
 * through the same tools, the same board and the same loop as every other seat.
 *
 * It reads the same structured sections a trader's prompt carries, with the reader the scripted policy also uses
 * (`cues/prompt-cues.ts`). One action per turn; whatever is left stays on the board and wakes it again.
 *
 * Since instrument v4 (D30) every payment is a direct transfer to the seller, so there is no escrow for it to release: a
 * unit of raw work is credited when its quote is paid, and the payment has already reached ISSUER-B.
 *
 * What it does NOT do is serve a claim. Raw work paid in fSIU arrives as a keyed transfer of a claim to the issuer, which
 * the lab credits when the payment is recorded; the issuer simply holds the claim, and it expires with the window like any
 * other (plan D8).
 */
import type { Adapter, AdapterResult } from "@touchstone/harness";
import { openRequests } from "../cues/prompt-cues.js";
import type { ToolName } from "../tools/index.js";

/** The only tool the service needs. */
export const ISSUER_SERVICE_TOOLS: readonly ToolName[] = ["issue_quote"];

const free = (intent: unknown): AdapterResult => ({
  text: JSON.stringify(intent),
  stopReason: "end_turn",
  usage: { input: 0, output: 0, cached_input: 0, reasoning: 0 },
  latency_ms: 0,
  raw: {},
  deviations: [],
});

/** Answers the first open request, else waits. */
export function issuerServiceAdapter(): Adapter {
  return async (_model, prompt) => {
    const open = openRequests(prompt);
    if (open.length > 0) return free({ tool: "issue_quote", args: { requestId: open[0].requestId } });
    return free({ wait: true });
  };
}
