import { usdToMinorUnits } from "@touchstone/sdk";

/**
 * F3 — the integer control arm (`docs/gate-market-spec.md` §7.3, `docs/monetary-design.md` §3.3).
 * Confirmed by reading §3.3 directly: "integer work units" is the SAME dollar value re-expressed
 * as an integer count of USDC minor units (`0.00034` vs `340` — a factor of exactly 1e6, USDC's
 * own decimals), not a separately-derived SIU/mSIU quantity. This is a direct, small reuse of
 * `usdToMinorUnits` (`@touchstone/sdk`'s existing decimal<->minor-unit conversion), not new
 * conversion logic.
 *
 * "Every agent decision involving a numeric comparison... is executed twice against identical
 * state... Only one arm's decision is acted on; the other is recorded and discarded. Alternate
 * which arm is live to avoid path divergence." (§7.3) — one `DualRenderer` per agent alternates
 * `liveArm` on every call and keeps every record for later F3 analysis.
 */
export type DualRenderArm = "decimal" | "integer";

export interface DualRenderRecord {
  decimalUsd: string;
  integerMinorUnits: string;
  liveArm: DualRenderArm;
}

export class DualRenderer {
  private nextArm: DualRenderArm = "decimal";
  private readonly records: DualRenderRecord[] = [];

  render(usdDecimalString: string): DualRenderRecord {
    const record: DualRenderRecord = {
      decimalUsd: usdDecimalString,
      integerMinorUnits: usdToMinorUnits(usdDecimalString),
      liveArm: this.nextArm,
    };
    this.records.push(record);
    this.nextArm = this.nextArm === "decimal" ? "integer" : "decimal";
    return record;
  }

  /** The value form the agent actually acts on for this record — whichever arm was live. */
  liveValue(record: DualRenderRecord): string {
    return record.liveArm === "decimal" ? record.decimalUsd : record.integerMinorUnits;
  }

  allRecords(): readonly DualRenderRecord[] {
    return this.records;
  }
}
