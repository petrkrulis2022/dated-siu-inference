/**
 * Runs economy windows (WP5): each window opens (the roll, NAV, needs), every agent takes one turn per round in a seeded order, the last round carries the lapse warnings, and the
 * window closes. Invariants are checked after every turn and every step; a failing invariant stops the run (§6, stop rules), as do the spend cap and a parse-failure rate above a
 * fifth of at least twenty turns.
 *
 * `buildWorld` wires a world from the committed parameters and WP0's figures: each issuer's price per task (its measured cost per pass, in Commodity SIU) and, for the stand-in
 * worker, its measured pass rate per task type.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { D, type DecimalValue } from "@touchstone/sdk";
import { CR_PUBLIC_DIR } from "../paths.js";
import { TASKS, type TaskId } from "../tasks/instances.js";
import { SeedStream } from "../tasks/seeds.js";
import type { Agent } from "./agents.js";
import { boardFor, renderBoard } from "./board.js";
import { EconomyLog } from "./log.js";
import type { Series } from "./memory-chain.js";
import type { EconomyParams } from "./params.js";
import { parseToolCall } from "./parse.js";
import type { NanoUsdPerSiu } from "./units.js";
import type { MicroSiu, TaskWorker } from "./world.js";
import { World } from "./world.js";

export interface CrPrintFile {
  issuers: {
    model: string;
    grade: string;
    perType: Record<TaskId, { answers: number; passes: number; headlineCostUsd: string }>;
  }[];
  prints: { grade: string; nanoUsdPerSiu: string | null }[];
}
export const CR_PRINT_PATH = join(CR_PUBLIC_DIR, "economy", "cr-print.json");
export const loadCrPrint = (path = CR_PRINT_PATH): CrPrintFile =>
  JSON.parse(readFileSync(path, "utf-8")) as CrPrintFile;

/** each issuer's price per task in micro-SIU of the Commodity grade: its cost per pass at that type ÷ the Commodity print, rounded up */
export function taskPrices(
  params: EconomyParams,
  wp0: CrPrintFile,
): Record<string, Partial<Record<TaskId, MicroSiu>>> {
  const commodity = wp0.prints.find((p) => p.grade === "commodity")?.nanoUsdPerSiu;
  if (commodity === null || commodity === undefined)
    throw new Error("WP0: no Commodity CR print, so no price can be quoted in SIU");
  const usdPerSiu = new D(commodity).div(1e9);
  const out: Record<string, Partial<Record<TaskId, MicroSiu>>> = {};
  for (const i of params.issuers) {
    const m = wp0.issuers.find((x) => x.model === i.model);
    if (m === undefined) throw new Error(`WP0 has no figures for ${i.model}`);
    out[i.id] = {};
    for (const t of i.classes) {
      const r = m.perType[t];
      if (r.passes === 0) continue;
      const perPass = new D(r.headlineCostUsd).div(r.passes);
      (out[i.id] as Partial<Record<TaskId, MicroSiu>>)[t] = BigInt(
        perPass.div(usdPerSiu).times(1e6).ceil().toFixed(0),
      );
    }
  }
  return out;
}

/** each issuer model's measured pass rate per task type, basis points, for the stand-in worker */
export function passRates(wp0: CrPrintFile): Record<string, Partial<Record<TaskId, number>>> {
  const out: Record<string, Partial<Record<TaskId, number>>> = {};
  for (const m of wp0.issuers) {
    out[m.model] = {};
    for (const t of TASKS) {
      const r = m.perType[t];
      if (r.answers > 0)
        (out[m.model] as Partial<Record<TaskId, number>>)[t] = Math.floor(
          (r.passes * 10_000) / r.answers,
        );
    }
  }
  return out;
}

export function buildWorld(opts: {
  params: EconomyParams;
  wp0: CrPrintFile;
  log: EconomyLog;
  worker: TaskWorker;
  t0: number;
  dataSha: (k: number) => string;
  /** v2 item 8: how many windows this run has, for the hedger's own due-by-window schedule (World.totalWindows); omit for every caller that doesn't need it */
  windowCount?: number;
  /** v2 item 10: window -> that day's real print rates (World.priceSchedule); omit to keep one fixed rate for the whole run, as before */
  priceSchedule?: ReadonlyMap<number, Readonly<Record<Series, NanoUsdPerSiu>>>;
}): World {
  const nano = (g: string): bigint => {
    const v = opts.wp0.prints.find((p) => p.grade === g)?.nanoUsdPerSiu;
    if (v === null || v === undefined) throw new Error(`WP0: no ${g} CR print`);
    return BigInt(v);
  };
  const clock = { now: opts.t0 };
  const w = new World(
    opts.params,
    opts.log,
    opts.worker,
    { commodity: nano("commodity"), frontier: nano("frontier") },
    taskPrices(opts.params, opts.wp0),
    opts.dataSha,
    (k) => new Date((opts.t0 + k * opts.params.secondsPerWindow) * 1000).toISOString().slice(0, 10),
    opts.t0,
    clock,
    opts.windowCount,
    opts.priceSchedule,
  );
  return w;
}

/**
 * Every account's USDC and AGU-lab right after `genesis()`, found by running genesis itself on a scratch world (in-memory log, no task work) -- so anything that shows
 * starting balances (the studio's roster) derives them exactly as a run does, never by echoing the params file (v3a Phase 2 item 6: the studio showed v2's hedger with
 * 0.10 USDC and no AGU-lab, when genesis gives it 0.05 USDC and half its money's worth in AGU-lab).
 */
export function genesisBalances(
  params: EconomyParams,
  wp0: CrPrintFile,
): Map<string, { usdc: bigint; agu: bigint }> {
  const w = buildWorld({
    params,
    wp0,
    log: new EconomyLog("stand-in"),
    worker: {
      work: () => Promise.reject(new Error("genesis does no task work")),
    },
    t0: 0,
    dataSha: standInSha(params.seed),
  });
  w.genesis();
  const out = new Map<string, { usdc: bigint; agu: bigint }>();
  for (const a of new Set([...w.chain.usdc.keys(), ...w.chain.agu.keys()]))
    out.set(a, { usdc: w.chain.balance(a, "USDC"), agu: w.chain.balance(a, "AGU") });
  return out;
}

/** a stand-in day's hash: the label says what it is, so it can never be mistaken for a snapshot's */
export const standInSha =
  (seed: string) =>
  (k: number): string =>
    createHash("sha256").update(`stand-in:${seed}:${k}`).digest("hex");

/** the needs schedule: each demand agent needs a brief on two task types each window, drawn from the seed */
export function needsSchedule(seed: string, tasks: readonly TaskId[]) {
  return (agent: string, k: number): TaskId[] => {
    const s = new SeedStream(seed, `needs:${agent}:${k}`);
    const first = tasks[s.next(tasks.length)] as TaskId;
    const rest = tasks.filter((t) => t !== first);
    return [first, rest[s.next(rest.length)] as TaskId];
  };
}

export interface WindowStats {
  window: number;
  turns: number;
  parseFailures: number;
  serviceFailures: number;
  flagged: { agent: string; round: number; flags: string[] }[];
  /** the mirrored sample: the same board asked again with the other display, never executed */
  mirrors: {
    agent: string;
    round: number;
    original: { siuFirst: boolean; tool: string; flags: string[] };
    mirror: { siuFirst: boolean; parsed: boolean; flags: string[]; tool: string | undefined };
  }[];
  agentCostUsd: DecimalValue;
  workCostUsd: DecimalValue;
}

export class StopRule extends Error {
  constructor(why: string) {
    super(why);
    this.name = "StopRule";
  }
}

export async function runWindows(opts: {
  world: World;
  /** the agents, or the agents of each window (counted windows rotate the seat's model by day, D75) */
  agents: Agent[] | ((k: number) => Agent[]);
  windows: number[];
  needsFor: (agent: string, k: number) => TaskId[];
  /** the system prompt a model agent gets before its board; scripted agents ignore it */
  instructions?: (role: string, siuFirst: boolean) => string;
}): Promise<WindowStats[]> {
  const w = opts.world;
  const stats: WindowStats[] = [];
  for (const k of opts.windows) {
    const s: WindowStats = {
      window: k,
      turns: 0,
      parseFailures: 0,
      serviceFailures: 0,
      flagged: [],
      mirrors: [],
      agentCostUsd: new D(0),
      workCostUsd: new D(0),
    };
    stats.push(s);
    w.workSpendUsd = new D(0);
    w.startWindow(k, opts.needsFor);
    w.checkInvariants();
    for (let r = 0; r < w.params.roundsPerWindow; r++) {
      w.setTime(k, r);
      if (r === w.params.roundsPerWindow - 1) w.lapseWarnings(k);
      const agents = typeof opts.agents === "function" ? opts.agents(k) : opts.agents;
      const order = seededOrder(w.params.seed, k, r, agents);
      for (const a of order) {
        const board = boardFor(w, a.id);
        const prompt = `${opts.instructions?.(a.role, board.siuFirst) ?? ""}\n\n${renderBoard(board)}`;
        const rep = await a.reply(board, prompt);
        s.turns++;
        s.agentCostUsd = s.agentCostUsd.plus(rep.costUsd);
        // v3a Phase 2 item 5: a service failure no longer `continue`s past the checks at the bottom of this loop -- it skipped the stop rule, so a window could lose every
        // turn to failed calls and run on (v2's window 7)
        const parsed = rep.serviceFailure === undefined ? parseToolCall(rep.toolCall, a.role, board) : undefined;
        if (parsed === undefined) {
          s.serviceFailures++;
          w.log.write(board.day, r, a.id, "turn", {
            seat: a.seat,
            parsed: false,
            serviceFailure: rep.serviceFailure,
          });
          w.lastResult.set(a.id, "your last turn was lost to a service failure; nothing happened");
        } else if (!parsed.ok) {
          s.parseFailures++;
          w.log.write(board.day, r, a.id, "turn", {
            seat: a.seat,
            parsed: false,
            error: parsed.error,
            ...(rep.stopReason !== undefined ? { stopReason: rep.stopReason } : {}),
            ...(rep.toolCall !== undefined
              ? { raw: JSON.stringify(rep.toolCall).slice(0, 2000) }
              : {}),
          });
          w.lastResult.set(a.id, `your last turn could not be used (${parsed.error})`);
        } else {
          w.log.write(board.day, r, a.id, "reasoning", {
            seat: a.seat,
            text: parsed.reasoning,
            ...(rep.reasoningSummary !== undefined ? { providerSummary: rep.reasoningSummary } : {}),
          });
          if (parsed.flags.length > 0)
            s.flagged.push({ agent: a.id, round: r, flags: parsed.flags });
          // the mirrored sample (D82): a seeded share of model turns is asked again with the other display (SIU first versus dollars first); the mirror is never executed
          if (
            a.seat !== "scripted" &&
            mirrored(w.params.seed, k, r, a.id, w.params.mirroredShareBps)
          ) {
            const flipped = { ...board, siuFirst: !board.siuFirst, notices: [] };
            const m = await a.reply(
              flipped,
              `${opts.instructions?.(a.role, flipped.siuFirst) ?? ""}\n\n${renderBoard(flipped)}`,
            );
            s.agentCostUsd = s.agentCostUsd.plus(m.costUsd);
            const mp =
              m.serviceFailure === undefined ? parseToolCall(m.toolCall, a.role, flipped) : undefined;
            const entry = {
              siuFirst: flipped.siuFirst,
              parsed: mp?.ok === true,
              flags: mp?.ok === true ? mp.flags : [],
              tool: mp?.ok === true ? mp.action.tool : undefined,
            };
            s.mirrors.push({
              agent: a.id,
              round: r,
              original: { siuFirst: board.siuFirst, tool: parsed.action.tool, flags: parsed.flags },
              mirror: entry,
            });
            w.log.write(board.day, r, a.id, "turn", {
              seat: a.seat,
              mirror: true,
              executed: false,
              ...entry,
              ...(mp !== undefined && !mp.ok ? { error: mp.error } : {}),
            });
          }
          const out = await w.act(a.id, parsed.action, parsed.reasoning);
          w.log.write(board.day, r, a.id, "turn", {
            seat: a.seat,
            parsed: true,
            tool: parsed.action.tool,
            ok: out.ok,
            note: out.note,
            flags: parsed.flags,
          });
        }
        w.checkInvariants();
        // v3a Phase 2 item 5: a turn lost to a service failure counts as lost, exactly like one that could not be parsed
        if (s.turns >= 20 && (s.parseFailures + s.serviceFailures) * 5 > s.turns)
          throw new StopRule(
            `more than a fifth of ${s.turns} turns were lost (${s.parseFailures} parse failures, ${s.serviceFailures} service failures)`,
          );
        if (s.agentCostUsd.plus(w.workSpendUsd).gt(w.params.spendCapUsdPerWindow))
          throw new StopRule("the window's spend cap is reached");
      }
    }
    w.closeWindow(k);
    w.checkInvariants();
    s.workCostUsd = w.workSpendUsd;
  }
  return stats;
}

function mirrored(seed: string, k: number, r: number, agent: string, shareBps: bigint): boolean {
  return new SeedStream(seed, `mirror:${k}:${r}:${agent}`).next(10_000) < Number(shareBps);
}

function seededOrder<T>(seed: string, k: number, r: number, xs: readonly T[]): T[] {
  const s = new SeedStream(seed, `order:${k}:${r}`);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = s.next(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
