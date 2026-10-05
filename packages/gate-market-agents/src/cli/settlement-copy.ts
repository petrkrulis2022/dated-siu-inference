import type { CapacityEvent, TurnLog } from "../loop/full-run.js";

export interface SettlementCopyRow {
  agentId: string;
  turn: number;
  tokenId?: string;
  /** What the settlement actually did, as the tool's own receipt decoded it. */
  outcome?: "Defaulted" | "Expired";
  /**
   * Did the agent that settled read that outcome in its very next prompt? `null` when it could not
   * have: the settlement's outcome was not decoded, or the agent took no turn afterwards.
   */
  shownToSettler: boolean | null;
}

/**
 * For each settlement, whether the agent that made it was told, in its next prompt, what it did.
 *
 * A settlement is the one act whose consequence differs by a fact the agent may not know —
 * presented and unserved pays the holder from the bond, unpresented pays nobody — and run 17's
 * settler acted "as instructed" and burned another agent's claim without being told the result
 * could be nothing (fsiu-design.md §4.3a). What the settler is then SHOWN is therefore part of the
 * instrument, and the scripted walk checks it from the recorded prompt, not from the tool's result.
 */
export function settlementCopyShown(
  capacityEvents: readonly CapacityEvent[],
  turnLogsByAgent: Readonly<Record<string, readonly TurnLog[]>>,
): SettlementCopyRow[] {
  return capacityEvents
    .filter((e) => e.kind === "settle_window_close")
    .map((e) => {
      const next = turnLogsByAgent[e.agentId]?.find((l) => l.turn === e.turn + 1);
      const shown =
        e.settlementOutcome === undefined || next?.promptText === undefined
          ? null
          : next.promptText.includes(e.settlementOutcome);
      return {
        agentId: e.agentId,
        turn: e.turn,
        ...(e.tokenId !== undefined ? { tokenId: e.tokenId } : {}),
        ...(e.settlementOutcome !== undefined ? { outcome: e.settlementOutcome } : {}),
        shownToSettler: shown,
      };
    });
}
