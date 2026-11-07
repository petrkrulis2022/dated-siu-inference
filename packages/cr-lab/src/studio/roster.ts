/**
 * Agent Studio, screen 1 (Part 2 of the marketplace redesign, 2026-11-07): the seven agents exactly as a run configured them, read from the committed parameters file plus the
 * instructions code itself — never from a live run or a stored log, so this works before, during the design of, or long after any run. The run's own seed is NEVER read from
 * the committed parameters' own `seed` field (that field is `"dev-0"`, a development default): `economy-score` scoring the counted run against that default instead of the
 * run's real seed (`counted-2026-11-06`) silently broke kill criterion 4 (D133). The caller must pass the real seed explicitly; there is no silent fallback here.
 */
import type { EconomyParams } from "../economy/params.js";
import { instructionsFor } from "../economy/model-agent.js";
import { TOOLS_BY_ROLE } from "../economy/parse.js";
import { needsSchedule } from "../economy/runner.js";
import { show } from "../economy/units.js";
import { TASKS, type TaskId } from "../tasks/instances.js";
import type { Role } from "../economy/world.js";

export type StudioRole = Role | "participant";

export interface SeatWindow {
  window: number;
  day: string | undefined;
  model: string;
}

export interface MandateView {
  spendLimitAgu: string;
  minUsdcBuffer: string;
  holdingCeilingDays: number;
  sweepDays: number[];
}

export interface HedgerView {
  briefsSold: number;
  /** narrative only (D131/D133): no "sale" transaction exists in the log, it is purely the backstory's own number */
  priceUsdcPerBriefNarrativeOnly: string;
}

export interface ParticipantView {
  spreadBps: number;
  buybackCapBps: number;
}

export interface NeedWindow {
  window: number;
  day: string | undefined;
  tasks: TaskId[];
}

export interface AgentConfig {
  id: string;
  role: StudioRole;
  startingUsdc: string;
  startingAgu: string;
  tools?: readonly string[];
  instructions?: string;
  mandate?: MandateView;
  hedger?: HedgerView;
  participant?: ParticipantView;
  needsByWindow?: NeedWindow[];
}

export interface StudioRoster {
  seed: string;
  days: string[];
  /** v1 ties every model-driven agent to the SAME seat each window (`economy-window.ts`'s `agents = (k) => byModel.get(models[(k-1) % models.length])`) — one schedule, not seven */
  seatSchedule: SeatWindow[];
  agents: AgentConfig[];
}

/** which model plays every model-driven agent in window k, 1-indexed, matching `economy-window.ts`'s counted-mode rotation exactly */
function seatScheduleFor(params: EconomyParams, days: readonly string[]): SeatWindow[] {
  const seats = params.counted?.seats ?? [];
  return days.map((day, i) => {
    const k = i + 1;
    return { window: k, day, model: seats.length === 0 ? "(no counted.seats)" : (seats[(k - 1) % seats.length] as string) };
  });
}

export function buildRoster(params: EconomyParams, seed: string): StudioRoster {
  const days = params.counted?.days ?? [];
  const needsFor = needsSchedule(seed, TASKS.filter((t): t is TaskId => t !== "CR-VS"));

  const agents: AgentConfig[] = [];

  for (const id of params.agents.research)
    agents.push({
      id,
      role: "research",
      startingUsdc: show(params.researchUsdc),
      startingAgu: show(0n),
      tools: TOOLS_BY_ROLE.research,
      instructions: instructionsFor("research"),
    });

  for (const id of params.agents.demand) {
    const m = params.mandates[id];
    agents.push({
      id,
      role: "demand",
      startingUsdc: show(m?.usdc ?? 0n),
      startingAgu: show(0n),
      tools: TOOLS_BY_ROLE.demand,
      instructions: instructionsFor("demand"),
      mandate:
        m === undefined
          ? undefined
          : {
              spendLimitAgu: show(m.spendLimitAguPerWindow),
              minUsdcBuffer: show(m.minUsdcBuffer),
              holdingCeilingDays: m.holdingCeilingDays,
              sweepDays: m.sweepDays,
            },
      needsByWindow: days.map((day, i) => ({
        window: i + 1,
        day,
        tasks: [...new Set(needsFor(id, i + 1))],
      })),
    });
  }

  agents.push({
    id: params.agents.hedger,
    role: "hedger",
    startingUsdc: show(params.hedger.usdc),
    startingAgu: show(0n),
    tools: TOOLS_BY_ROLE.hedger,
    instructions: instructionsFor("hedger"),
    hedger: {
      briefsSold: params.hedger.briefsSold,
      priceUsdcPerBriefNarrativeOnly: show(params.hedger.priceUsdcPerBrief),
    },
  });

  agents.push({
    id: "PARTICIPANT",
    role: "participant",
    startingUsdc: show(params.participant.usdc),
    startingAgu: show(0n),
    participant: {
      spreadBps: Number(params.participant.spreadBps),
      buybackCapBps: Number(params.participant.buybackCapBps),
    },
  });

  return { seed, days, seatSchedule: seatScheduleFor(params, days), agents };
}
