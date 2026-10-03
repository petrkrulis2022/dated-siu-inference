import type { AgentId } from "../identity/resolve.js";
import type { CapacityEvent, FullRunWindowResult } from "./full-run.js";

export interface PurchaseDecision {
  buyer: AgentId;
  turn: number;
  /** What the buyer actually settled in. `split` carries `claimShare`. */
  asset: "usdc" | "fsiu" | "split";
  /** Claim share of the quote, 0..1 as a decimal string — only for `split`. */
  claimShare?: string;
  quantityMilliSiu?: string;
  tokenId?: string;
}

export interface ClaimJourney {
  tokenId: string;
  /** Agent-to-agent transfers AFTER the payment that created it. 0 means it never moved. */
  hops: number;
  /** Turns between the claim arriving and the holder doing something with it. */
  turnsHeld: number;
  outcome: "redeemed" | "passed_onward" | "outstanding";
}

export interface PurchaseSummary {
  decisions: PurchaseDecision[];
  journeys: ClaimJourney[];
}

/**
 * Who bought what, in which asset, and what happened to each claim afterwards.
 *
 * **Attributed per buyer, never pooled.** From Phase 5 there are two deciders — ORCHESTRATOR
 * buying gate authoring and WORKER-CODE buying attack testing — and F1 is a question about each
 * of them separately. Pooling their choices would produce a single ratio that describes neither:
 * one is a buyer spending its own budget on work it needs, the other is a seller spending what
 * it was just paid, and there is no reason to expect those to behave alike. The predecessor of
 * this function hardcoded `ORCHESTRATOR` and would silently have reported one of the two.
 *
 * **`passed_onward` is the circulation result.** Every claim in every run to date was redeemed on
 * the turn after it arrived, which makes fSIU a settlement rail rather than money. A claim that
 * moves holder-to-holder before being redeemed is the thing the instrument is supposed to do and
 * has never done, so it is counted separately rather than folded into "redeemed eventually".
 */
export function summarisePurchases(result: FullRunWindowResult): PurchaseSummary {
  const events = result.capacityEvents;
  const decisions: PurchaseDecision[] = [];

  // Dollar settlements leave no capacity event — `pay` opens an escrow and moves no bonded
  // capacity — so they are read from each agent's own tool calls. Per agent, not just the
  // orchestrator's.
  for (const [agentId, logs] of Object.entries(result.turnLogsByAgent)) {
    for (const log of logs) {
      if (settledInDollars(log)) {
        decisions.push({ buyer: agentId as AgentId, turn: log.turn, asset: "usdc" });
      }
    }
  }
  for (const e of events) {
    if (e.kind === "pay_with_claim" || e.kind === "mint_claim") {
      decisions.push({
        buyer: e.agentId,
        turn: e.turn,
        asset: "fsiu",
        ...(e.quantityMilliSiu ? { quantityMilliSiu: e.quantityMilliSiu } : {}),
        ...(e.tokenId ? { tokenId: e.tokenId } : {}),
      });
    }
    if (e.kind === "settle_split") {
      decisions.push({
        buyer: e.agentId,
        turn: e.turn,
        asset: "split",
        ...(e.claimShare ? { claimShare: e.claimShare } : {}),
        ...(e.quantityMilliSiu ? { quantityMilliSiu: e.quantityMilliSiu } : {}),
        ...(e.tokenId ? { tokenId: e.tokenId } : {}),
      });
    }
  }
  decisions.sort((a, b) => a.turn - b.turn);

  return { decisions, journeys: journeysFrom(events) };
}

/**
 * Did this turn settle a quote in dollars — genuinely, not merely attempt to?
 *
 * Added 2026-10-02 alongside spec §4.6af, which is the same mistake seen from the other side.
 * This function used to ask `log.parsed.includes('"pay"')`, and on a FAILED call the loop writes
 * `parsed` as `{"tool":"pay",…} -> tool call error: …` — which contains `"pay"`. So a reverted
 * or refused payment was reported as a settled one, and the run report's own asset-choice line
 * over-counted the dollar route by every failure.
 *
 * `toolCall` is the recorded fact and is preferred wherever it exists. Records written before
 * that field did not carry it, so the text is still read for them — but with the failure marker
 * excluded, which is the part the old check was missing rather than a new guess.
 */
function settledInDollars(log: { parsed: string; toolCall?: { name: string; ok: boolean } }): boolean {
  if (log.toolCall !== undefined) return log.toolCall.name === "pay" && log.toolCall.ok;
  return log.parsed.includes('"pay"') && !log.parsed.includes("-> tool call error:");
}

function journeysFrom(events: readonly CapacityEvent[]): ClaimJourney[] {
  const byToken = new Map<string, CapacityEvent[]>();
  for (const e of events) {
    if (!e.tokenId) continue;
    const list = byToken.get(e.tokenId) ?? [];
    list.push(e);
    byToken.set(e.tokenId, list);
  }

  const journeys: ClaimJourney[] = [];
  for (const [tokenId, list] of byToken) {
    const created = list.find((e) => e.kind === "pay_with_claim" || e.kind === "mint_claim" || e.kind === "settle_split");
    if (!created) continue;
    const hops = list.filter((e) => e.kind === "transfer_claim").length;
    const disposal = list.find((e) => e.kind === "redeem_claim" || e.kind === "transfer_claim");
    journeys.push({
      tokenId,
      hops,
      turnsHeld: disposal ? disposal.turn - created.turn : 0,
      outcome:
        disposal === undefined
          ? "outstanding"
          : disposal.kind === "transfer_claim"
            ? "passed_onward"
            : "redeemed",
    });
  }
  return journeys;
}

/** One line per buyer, for the run report. Never a single pooled ratio — see above. */
export function renderPurchaseSummary(summary: PurchaseSummary): string[] {
  const buyers = [...new Set(summary.decisions.map((d) => d.buyer))];
  if (buyers.length === 0) return ["  no purchase decision was reached this window"];

  const lines = buyers.map((b) => {
    const mine = summary.decisions.filter((d) => d.buyer === b);
    const usdc = mine.filter((d) => d.asset === "usdc").length;
    const fsiu = mine.filter((d) => d.asset === "fsiu").length;
    const splits = mine.filter((d) => d.asset === "split");
    const splitText =
      splits.length === 0
        ? ""
        : `, ${splits.length} split (claim share ${splits.map((s) => s.claimShare ?? "?").join(", ")})`;
    return `  ${b}: ${usdc} in USDC, ${fsiu} in fSIU${splitText}`;
  });

  const passed = summary.journeys.filter((j) => j.outcome === "passed_onward");
  lines.push(
    passed.length === 0
      ? "  claims passed onward rather than redeemed: 0 — fSIU settled, it did not circulate"
      : `  claims PASSED ONWARD rather than redeemed: ${passed.length} (hops: ${passed.map((p) => p.hops).join(", ")})`,
  );
  return lines;
}
