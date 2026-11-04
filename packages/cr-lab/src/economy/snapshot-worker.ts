/**
 * The issuers' task work on STORED Blockworks snapshots (development window DW4 and counted windows while the licence allows it, i.e. no later than the end of the trial's deletion
 * window): an issuer's own model answers a freshly drawn instance of the task type on that window's stored day, through the same answer runner, prompt and gate as snapshot mode,
 * and through the trial's spend ledger (part `economy`). ISSUER-X's published failure share is drawn first from the seed: a presentation it fails is not worked at all, so it costs
 * nothing, as a default does not.
 *
 * Economy window k maps to a stored day; the window's data hash is that day's hash (`daySha256`), so a brief's components all come from one snapshot. Nothing here reads a live API.
 */
import { D } from "@touchstone/sdk";
import type { SnapshotStore } from "../data-desk/snapshots.js";
import { buildPrompt } from "../runner/prompts.js";
import type { AnswerRecord } from "../runner/records.js";
import { runAnswer, type Seat } from "../runner/run-answer.js";
import { daySha256 } from "../runner/run-day.js";
import type { SpendLedger } from "../spend/ledger.js";
import { loadDay, type DayData } from "../tasks/day-data.js";
import { drawInstances, type TaskId } from "../tasks/instances.js";
import { SeedStream } from "../tasks/seeds.js";
import type { IssuerParams } from "./params.js";
import type { TaskWorker, WorkOutcome } from "./world.js";

export interface StoredDay {
  window: string;
  day: DayData;
  sha: string;
}

export function loadStoredDays(store: SnapshotStore, windows: readonly string[]): StoredDay[] {
  return windows.map((w) => ({ window: w, day: loadDay(store, w), sha: daySha256(store, w) }));
}

export class SnapshotModelWorker implements TaskWorker {
  readonly answers: AnswerRecord[] = [];
  readonly skippedByShare: { issuer: string; task: TaskId; window: number }[] = [];
  readonly unservable: { issuer: string; task: TaskId; window: number }[] = [];

  constructor(
    /** economy window index → the stored day it runs on */
    readonly days: ReadonlyMap<number, StoredDay>,
    /** issuer model id → its seat */
    readonly seats: ReadonlyMap<string, Seat>,
    readonly ledger: SpendLedger,
    readonly seed: string,
  ) {}

  dataSha(k: number): string {
    const d = this.days.get(k);
    if (d === undefined) throw new Error(`no stored day for economy window ${k}`);
    return d.sha;
  }

  async work(
    issuer: IssuerParams,
    task: TaskId,
    ctx: { window: number; round: number; key: string },
  ): Promise<WorkOutcome> {
    const d = this.days.get(ctx.window);
    if (d === undefined) throw new Error(`no stored day for economy window ${ctx.window}`);
    const s = new SeedStream(this.seed, `x:${issuer.id}:${ctx.key}`);
    if (issuer.failShareBps > 0n && s.next(10_000) < Number(issuer.failShareBps)) {
      this.skippedByShare.push({ issuer: issuer.id, task, window: ctx.window });
      return { passed: false, costUsd: new D(0), dataSha: d.sha };
    }
    const inst = drawInstances(d.day, `${this.seed}:${ctx.key}`, 1).find((i) => i.task === task);
    const bundle = inst === undefined ? undefined : buildPrompt(inst, d.day);
    if (inst === undefined || bundle === undefined) {
      this.unservable.push({ issuer: issuer.id, task, window: ctx.window });
      return { passed: false, costUsd: new D(0), dataSha: d.sha };
    }
    const seat = this.seats.get(issuer.model);
    if (seat === undefined) throw new Error(`no seat for ${issuer.model}`);
    const rec = await runAnswer({
      ledger: this.ledger,
      seat,
      instance: inst,
      bundle,
      window: d.window,
      daySha256: d.sha,
      part: "economy",
    });
    this.answers.push(rec);
    return { passed: rec.passed, costUsd: new D(rec.usd), dataSha: d.sha };
  }
}
