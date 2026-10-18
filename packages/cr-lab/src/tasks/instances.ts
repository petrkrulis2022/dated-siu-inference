/**
 * The day's instances (§16.6): from the candidates in the day's snapshot, a seeded draw of three per task (fewer where there are fewer options). The options are listed in a fixed
 * order and only if their reference solver can answer them, then shuffled by the day's committed seed, so the same seed over the same snapshot always gives the same questions and
 * nothing is offered that cannot be checked. The instance carries its reference answer, which is private data (it is derived from Blockworks' numbers).
 */
import { SeedStream, shuffle } from "./seeds.js";
import type { DayData } from "./day-data.js";
import {
  plQuarters,
  solvePL,
  solveSM,
  solveUO,
  solveVS,
  vsEndMonths,
  type Dimension,
  type PLReference,
  type SMReference,
  type UOReference,
  type VSReference,
} from "./solve.js";

export type TaskId = "CR-VS" | "CR-PL" | "CR-UO" | "CR-SM";
export const TASKS: readonly TaskId[] = ["CR-VS", "CR-PL", "CR-UO", "CR-SM"];
export const INSTANCES_PER_TASK = 3;

interface Base {
  id: string;
  window: string;
}
export type Instance =
  | (Base & {
      task: "CR-VS";
      params: { endMonth: string; months?: number };
      reference: VSReference;
    })
  | (Base & {
      task: "CR-PL";
      params: { protocolId: string; quarter: string; start: string; end: string };
      reference: PLReference;
    })
  | (Base & { task: "CR-UO"; params: { slug: string }; reference: UOReference })
  | (Base & { task: "CR-SM"; params: { dimension: Dimension }; reference: SMReference });

type Option = { key: string; make: (id: string) => Instance };

/** Every question the day's data can answer for each task, in a fixed order. */
export function optionsFor(day: DayData): Record<TaskId, Option[]> {
  const w = day.window;
  const vs: Option[] = [];
  for (const endMonth of vsEndMonths(w)) {
    const reference = solveVS(day, endMonth);
    if (reference !== undefined)
      vs.push({
        key: endMonth,
        make: (id) => ({ id, window: w, task: "CR-VS", params: { endMonth }, reference }),
      });
  }
  const pl: Option[] = [];
  for (const protocolId of [...day.lendingProtocols].sort()) {
    for (const q of plQuarters(w)) {
      const reference = solvePL(day, protocolId, q);
      if (reference !== undefined)
        pl.push({
          key: `${protocolId}/${q.label}`,
          make: (id) => ({
            id,
            window: w,
            task: "CR-PL",
            params: { protocolId, quarter: q.label, start: q.start, end: q.end },
            reference,
          }),
        });
    }
  }
  const uo: Option[] = [];
  for (const slug of [...day.schedules.keys()].sort()) {
    const reference = solveUO(day, slug);
    if (reference !== undefined)
      uo.push({
        key: slug,
        make: (id) => ({ id, window: w, task: "CR-UO", params: { slug }, reference }),
      });
  }
  const sm: Option[] = [];
  for (const dimension of ["chain", "issuer"] as const) {
    const reference = solveSM(day, dimension);
    if (reference !== undefined)
      sm.push({
        key: dimension,
        make: (id) => ({ id, window: w, task: "CR-SM", params: { dimension }, reference }),
      });
  }
  return { "CR-VS": vs, "CR-PL": pl, "CR-UO": uo, "CR-SM": sm };
}

/** The day's instances for every task, drawn with the day's seed. Tasks whose data is missing give none. */
export function drawInstances(
  day: DayData,
  seed: string,
  perTask = INSTANCES_PER_TASK,
): Instance[] {
  const options = optionsFor(day);
  const out: Instance[] = [];
  for (const task of TASKS) {
    const drawn = shuffle(options[task], new SeedStream(seed, task)).slice(0, perTask);
    drawn.forEach((o, i) => out.push(o.make(`${task}-${day.window}-${i + 1}`)));
  }
  return out;
}
