/**
 * v3a's market objects (docs/experiment-3a-design.md; the owner's decisions D143): PROVIDER's standing offers and buyers' requests, the public claims record, and the work
 * a task of each class is, in mSIU.
 *
 *  - An OFFER is PROVIDER's: claims of one class from one named issuer, for one window, up to a quantity, at a discount to that grade's print (negative: a premium), payable
 *    in USDC, AGU-lab or either, to everyone or one named buyer. PROVIDER may revise (replace) or withdraw it in any round; it lapses when its window closes.
 *  - A REQUEST is a buyer's: class, window and quantity. It stays on the board until PROVIDER answers it (an offer naming it, or a decline) or the window it was posted in
 *    closes.
 *  - The CLAIMS RECORD is per issuer and window: face minted, tasks presented and served, face served, face defaulted and face expired (claims in agents' hands; the
 *    reserve's own lots roll or lapse inside the AGU-lab mechanics and are shown in the NAV derivation instead).
 *  - A task's WORK, in mSIU of its grade: its grade issuers' measured cost per pass over the grade's print, rounded up (WP0). It is fixed for the run: a claim buys the same
 *    work whatever the print does later ("fixed in work, floating in dollars"), while a commission's list price follows its class print's own small drift.
 */
import { D } from "@touchstone/sdk";
import type { TaskId } from "../tasks/instances.js";
import type { Series } from "./memory-chain.js";
import type { EconomyParams } from "./params.js";
import type { PathPoint } from "./price-path.js";
import type { CrPrintFile } from "./runner.js";
import type { MilliSiu } from "./units.js";

export type Accept = "usdc" | "agu" | "both";
export type Arm = "A" | "B";

export interface Offer {
  id: string;
  issuer: string;
  task: TaskId;
  series: Series;
  window: number;
  milliLeft: MilliSiu;
  discountBps: bigint;
  accept: Accept;
  /** "all", or the one buyer it is offered to */
  to: string;
  request?: string;
  postedWindow: number;
  postedRound: number;
  status: "live" | "withdrawn" | "replaced" | "sold out" | "lapsed";
}

export interface ClaimRequest {
  id: string;
  buyer: string;
  task: TaskId;
  window: number;
  milli: MilliSiu;
  postedWindow: number;
  postedRound: number;
  status: "open" | "answered" | "declined" | "lapsed";
  answer?: string;
}

export interface RecordRow {
  mintedMilli: bigint;
  presented: number;
  served: number;
  servedMilli: bigint;
  defaultedMilli: bigint;
  expiredMilli: bigint;
}
export const emptyRow = (): RecordRow => ({
  mintedMilli: 0n,
  presented: 0,
  served: 0,
  servedMilli: 0n,
  defaultedMilli: 0n,
  expiredMilli: 0n,
});

/** what a run of v3a is: its arm, its volatility setting and its price path (with the path seed's hash; the seed itself stays out of the world until the run ends) */
export interface V3aRun {
  arm: Arm;
  volatility: "low" | "high";
  path: PathPoint[];
  priceSeedHash: string;
  /** the counted cell this run is, when it is one */
  cell?: string;
}

export const acceptsPay = (a: Accept, pay: "usdc" | "agu"): boolean => a === "both" || a === pay;

/**
 * One task's work in mSIU of its grade, per class: the grade issuers' measured cost per pass (WP0, `cr-print.json`) over the grade's own print, rounded up. Commodity for
 * CR-PL, CR-UO and CR-SM (claude-haiku-5-5); Frontier for CR-VS (claude-sonnet-5).
 */
export function taskFaces(params: EconomyParams, wp0: CrPrintFile): Record<Series, Partial<Record<TaskId, MilliSiu>>> {
  const out: Record<Series, Partial<Record<TaskId, MilliSiu>>> = { commodity: {}, frontier: {} };
  for (const i of params.issuers) {
    const print = wp0.prints.find((p) => p.grade === i.grade)?.nanoUsdPerSiu;
    const m = wp0.issuers.find((x) => x.model === i.model);
    if (print === null || print === undefined || m === undefined) continue;
    for (const c of i.lotClasses ?? i.classes) {
      const r = m.perType[c];
      if (r.passes === 0 || out[i.grade][c] !== undefined) continue;
      const perPassUsd = new D(r.headlineCostUsd).div(r.passes);
      out[i.grade][c] = BigInt(perPassUsd.div(new D(print).div(1e9)).times(1000).ceil().toFixed(0));
    }
  }
  return out;
}
