/**
 * The currency lab's economy: who can do what, who needs what, and when. Generated ONCE per run from
 * the run's seed; the board, the guards, the briefs and the report all read this one object, so they
 * cannot disagree about the schedule (the same discipline as `RUN_PURCHASES` in the gate configuration).
 *
 * See `docs/marketplace_plan.md` §2.4. Every number is a default recorded there.
 */
import { deriveSeed, mulberry32 } from "@touchstone/basket";
import type { AgentId } from "../identity/resolve.js";

/** What an agent is shown. The seats underneath are existing ones; see plan D4. */
export const LAB_TRADERS = ["TRADER-1", "TRADER-2", "TRADER-3", "TRADER-4"] as const;
export type TraderLabel = (typeof LAB_TRADERS)[number];

/**
 * TRADER-4 runs on ISSUER-A's wallet: it is the only existing wallet nothing else in phase 1 uses
 * (HEDGER has none, and the plan says no new wallets). ISSUER-A is a registered issuer, so a mint that
 * overflowed past ISSUER-B would pay TRADER-4 — the contamination check aborts the run if any mint is
 * backed by anyone but ISSUER-B.
 */
export const SEAT_OF: Readonly<Record<TraderLabel, AgentId>> = {
  "TRADER-1": "ORCHESTRATOR",
  "TRADER-2": "WORKER-CODE",
  "TRADER-3": "WORKER-EXTRACT",
  "TRADER-4": "ISSUER-A",
};

export const ISSUER_SEAT: AgentId = "ISSUER-B";

/** The label an agent may use for a trader in a call's own arguments, and the seat it stands for. */
export const LAB_ALIASES: Readonly<Record<string, AgentId>> = Object.fromEntries(
  LAB_TRADERS.map((t) => [t, SEAT_OF[t]]),
);

/** What the quote board prints for a buyer: its label if it is a trader's seat, else the seat as it is. */
export function labDisplayName(seat: AgentId): string {
  return LAB_TRADERS.find((t) => SEAT_OF[t] === seat) ?? seat;
}

export const JOB_TYPES = ["TYPE-1", "TYPE-2", "TYPE-3", "TYPE-4"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface LabParams {
  rounds: number;
  needsPerTrader: number;
  /** One job, and one unit of raw work, is this many mSIU. */
  jobMilliSiu: number;
  /** The trade price per SIU as a multiple of the print, in basis points. */
  tradeMultiplierBps: number;
  /** What each need met adds to a result, as a multiple of the print per job, in basis points. */
  creditMultiplierBps: number;
  /** Each trader opens with this much fSIU, and USDC of equal value at the print. */
  openingMilliSiu: number;
}

/** Plan §2.11. Change them there first. */
export const DEFAULT_PARAMS: LabParams = {
  rounds: 3,
  needsPerTrader: 2,
  jobMilliSiu: 1000,
  tradeMultiplierBps: 12_000,
  creditMultiplierBps: 15_000,
  openingMilliSiu: 2000,
};

export interface Need {
  /** Stable within a run: "TRADER-2#1". */
  id: string;
  buyer: TraderLabel;
  type: JobType;
  /** The trader that holds the skill and so must be the seller. */
  seller: TraderLabel;
  /** Purchasable from this round on. */
  round: number;
}

export interface Economy {
  seed: number;
  params: LabParams;
  skillOf: Readonly<Record<TraderLabel, JobType>>;
  sellerOf: Readonly<Record<JobType, TraderLabel>>;
  needs: readonly Need[];
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Skills are a seeded permutation of the four job types. Each trader needs the types of the next
 * `needsPerTrader` traders in ring order, so every type is needed by exactly `needsPerTrader` buyers and
 * every seller sells the same number of jobs — the structure is balanced by construction and only the
 * assignment and the rounds depend on the seed. Rounds are a seeded draw of distinct rounds per trader,
 * redrawn until every round has at least one need.
 */
export function buildEconomy(seed: number, params: LabParams = DEFAULT_PARAMS): Economy {
  const n = LAB_TRADERS.length;
  if (params.needsPerTrader < 1 || params.needsPerTrader > n - 1) {
    throw new Error(`needsPerTrader must be between 1 and ${n - 1}, got ${params.needsPerTrader}`);
  }
  if (params.rounds < params.needsPerTrader) {
    throw new Error(`rounds (${params.rounds}) must be at least needsPerTrader (${params.needsPerTrader})`);
  }
  const skillRng = mulberry32(deriveSeed(seed, "skills"));
  const types = shuffled(JOB_TYPES, skillRng);
  const skillOf = Object.fromEntries(LAB_TRADERS.map((t, i) => [t, types[i]])) as Record<TraderLabel, JobType>;
  const sellerOf = Object.fromEntries(LAB_TRADERS.map((t) => [skillOf[t], t])) as Record<JobType, TraderLabel>;

  const roundRng = mulberry32(deriveSeed(seed, "rounds"));
  const allRounds = Array.from({ length: params.rounds }, (_, i) => i + 1);
  let needs: Need[] = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    needs = [];
    LAB_TRADERS.forEach((buyer, i) => {
      const rounds = shuffled(allRounds, roundRng).slice(0, params.needsPerTrader).sort((a, b) => a - b);
      for (let k = 1; k <= params.needsPerTrader; k++) {
        const seller = LAB_TRADERS[(i + k) % n];
        needs.push({
          id: `${buyer}#${k}`,
          buyer,
          type: skillOf[seller],
          seller,
          round: rounds[k - 1],
        });
      }
    });
    if (allRounds.every((r) => needs.some((x) => x.round === r))) break;
  }
  if (!allRounds.every((r) => needs.some((x) => x.round === r))) {
    throw new Error("could not place at least one need in every round");
  }
  return { seed, params, skillOf, sellerOf, needs };
}

export const needsOf = (e: Economy, buyer: TraderLabel): Need[] => e.needs.filter((x) => x.buyer === buyer);
export const needsInRound = (e: Economy, round: number): Need[] => e.needs.filter((x) => x.round === round);
export const salesOf = (e: Economy, seller: TraderLabel): Need[] => e.needs.filter((x) => x.seller === seller);

export function traderForSeat(seat: AgentId): TraderLabel | undefined {
  return LAB_TRADERS.find((t) => SEAT_OF[t] === seat);
}
