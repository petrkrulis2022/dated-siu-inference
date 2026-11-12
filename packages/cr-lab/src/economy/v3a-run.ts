/**
 * Building a v3a run (docs/experiment-3a-design.md): its seeded price path, its world and its cast, the same way for the run command and the tests.
 *
 * The price path comes from a price seed that stays out of the world: only its hash goes into the log at genesis (`World.genesis`), and the run command writes the seed
 * itself into the log only when the run has ended. For a counted cell the seed's hash must equal the one frozen in the parameters file, or the run refuses to start.
 */
import { TASKS, type TaskId } from "../tasks/instances.js";
import { StandInWorker } from "./agents.js";
import type { EconomyLog } from "./log.js";
import type { EconomyParams } from "./params.js";
import { pricePath, pricePathSeedHash, type PathPoint } from "./price-path.js";
import { buildWorld, loadV3aPassRates, needsSchedule, passRates, standInSha, type CrPrintFile } from "./runner.js";
import type { Arm } from "./v3a-market.js";
import type { Role, TaskWorker, World } from "./world.js";

export const BRIEF_TASKS: readonly TaskId[] = TASKS.filter((t): t is TaskId => t !== "CR-VS");

export function v3aPath(params: EconomyParams, wp0: CrPrintFile, priceSeed: string, volatility: "low" | "high"): PathPoint[] {
  const v = params.v3a;
  if (v === undefined) throw new Error("not a v3a parameters file");
  const grade = (g: string): bigint => {
    const n = wp0.prints.find((p) => p.grade === g)?.nanoUsdPerSiu;
    if (n === null || n === undefined) throw new Error(`WP0: no ${g} print`);
    return BigInt(n);
  };
  return pricePath({
    seed: priceSeed,
    volPpm: volatility === "high" ? v.printPath.highVolPpm : v.printPath.lowVolPpm,
    classNoisePpm: v.printPath.classNoisePpm,
    burnIn: v.printPath.burnIn,
    windows: v.windows,
    start: { commodity: grade("commodity"), frontier: grade("frontier") },
    classes: TASKS,
  });
}

/** every v3a model agent and its role, PROVIDER first */
export function v3aAgentIds(params: EconomyParams): [string, Role][] {
  const v = params.v3a;
  if (v === undefined) throw new Error("not a v3a parameters file");
  return [
    [v.provider, "provider"],
    ...params.agents.research.map((a): [string, Role] => [a, "research"]),
    ...params.agents.demand.map((a): [string, Role] => [a, "demand"]),
    [params.agents.hedger, "hedger"],
  ];
}

export interface V3aBuild {
  world: World;
  needsFor: (agent: string, k: number) => TaskId[];
  path: PathPoint[];
}

/** a v3a world after genesis, ready for `runWindows` over windows 1..8; the issuers do stand-in work at the committed pass rates unless a worker is given */
export function buildV3aWorld(opts: {
  params: EconomyParams;
  wp0: CrPrintFile;
  log: EconomyLog;
  t0: number;
  arm: Arm;
  volatility: "low" | "high";
  priceSeed: string;
  cell?: string;
  worker?: TaskWorker;
}): V3aBuild {
  const v = opts.params.v3a;
  if (v === undefined) throw new Error("not a v3a parameters file");
  const priceSeedHash = pricePathSeedHash(opts.priceSeed);
  if (opts.cell !== undefined) {
    const frozen = v.printPath.seedHashes[opts.cell];
    if (frozen === undefined) throw new Error(`no frozen price-path seed hash for cell ${opts.cell}`);
    if (frozen !== priceSeedHash) throw new Error(`the price seed given does not match cell ${opts.cell}'s frozen hash`);
  }
  const sha = standInSha(opts.params.seed);
  const path = v3aPath(opts.params, opts.wp0, opts.priceSeed, opts.volatility);
  const world = buildWorld({
    params: opts.params,
    wp0: opts.wp0,
    log: opts.log,
    worker: opts.worker ?? new StandInWorker(opts.params.seed, passRates(opts.wp0), sha, loadV3aPassRates(opts.params)),
    t0: opts.t0,
    dataSha: sha,
    v3a: { arm: opts.arm, volatility: opts.volatility, path, priceSeedHash, ...(opts.cell !== undefined ? { cell: opts.cell } : {}) },
  });
  world.genesis();
  world.checkInvariants();
  return { world, needsFor: needsSchedule(opts.params.seed, BRIEF_TASKS), path };
}
