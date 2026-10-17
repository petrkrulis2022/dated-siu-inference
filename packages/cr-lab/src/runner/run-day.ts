/**
 * One window of snapshot mode (§16.7): commit the day's seed, draw the instances from the day's data, ask every seat every instance once, record each answer, and write the tables.
 * A run can stop, and starting it again resumes: an (instance, model) pair already recorded for this window and part is never asked twice (no retries, so a recorded failure is final).
 *
 * It stops, rather than skips, when the spend guard refuses a call (`SpendStopped`): the cap, a provider's budget or a missing balance. Calls already in flight finish and are recorded; nothing new
 * starts, and the summary says why. The seed is revealed only when the whole window is complete and the part is `snapshot`.
 */
import { createHash } from "node:crypto";
import { D, roundHalfUp } from "@touchstone/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import type { SnapshotStore } from "../data-desk/snapshots.js";
import { SpendStopped, type SpendLedger } from "../spend/ledger.js";
import type { StopCode } from "../spend/check.js";
import type { DayData } from "../tasks/day-data.js";
import { drawInstances, type Instance, type TaskId } from "../tasks/instances.js";
import type { SeedBook } from "../tasks/seeds.js";
import { buildPrompt } from "./prompts.js";
import { runAnswer, type Seat } from "./run-answer.js";
import { recordKey, tablesDir, type AnswerRecord, type RecordStore } from "./records.js";
import { cumulativeTable, dailyTable, failureReport } from "./tables.js";

/** sha256 over the sorted body hashes of the window's snapshots: one value naming the exact data a day's answers were graded against. */
export function daySha256(store: SnapshotStore, window: string, tag = "daily"): string {
  const hashes = store
    .list(window, tag)
    .map((s) => s.meta.bodySha256)
    .sort();
  return createHash("sha256").update(hashes.join("\n")).digest("hex");
}

export interface RunDayInput {
  window: string;
  day: DayData;
  daySha256: string;
  seats: readonly Seat[];
  ledger: SpendLedger;
  seeds: SeedBook;
  records: RecordStore;
  /** instances per task, default 3 */
  perTask?: number;
  part?: "snapshot" | "dry-run";
  /** answers in flight at once, default 1 */
  concurrency?: number;
  /** stop starting new attempts after this many in this call (a cheap dry run) */
  maxAnswers?: number;
  /** only these tasks */
  tasks?: readonly TaskId[];
  log?: (line: string) => void;
  now?: () => Date;
}

export interface RunDaySummary {
  window: string;
  part: "snapshot" | "dry-run";
  planned: number;
  alreadyRecorded: number;
  attempted: number;
  passed: number;
  usd: string;
  /** instances the day's data could not build a prompt for */
  unservable: string[];
  stopped?: { code: StopCode; reason: string; provider: string };
  /** every planned attempt now has a record */
  complete: boolean;
  seedRevealed: boolean;
}

export async function runDay(input: RunDayInput): Promise<RunDaySummary> {
  const part = input.part ?? "snapshot";
  const log = input.log ?? (() => undefined);
  const concurrency = Math.max(1, input.concurrency ?? 1);

  input.seeds.commit(input.window);
  const seed = input.seeds.seedFor(input.window);
  const drawn = drawInstances(input.day, seed, input.perTask).filter(
    (i) => input.tasks === undefined || input.tasks.includes(i.task),
  );

  const unservable: string[] = [];
  const prompts = new Map<string, NonNullable<ReturnType<typeof buildPrompt>>>();
  const instances: Instance[] = [];
  for (const inst of drawn) {
    const bundle = buildPrompt(inst, input.day);
    if (bundle === undefined) unservable.push(inst.id);
    else {
      prompts.set(inst.id, bundle);
      instances.push(inst);
    }
  }

  const done = new Set(
    input.records
      .forWindow(input.window)
      .filter((r) => r.part === part)
      .map(recordKey),
  );
  const jobs: { instance: Instance; seat: Seat }[] = [];
  for (const instance of instances)
    for (const seat of input.seats)
      if (!done.has(recordKey({ instance: instance.id, model: seat.modelId })))
        jobs.push({ instance, seat });
  const planned = instances.length * input.seats.length;
  const alreadyRecorded = planned - jobs.length;
  log(
    `window ${input.window}, part ${part}: ${planned} attempts planned, ${alreadyRecorded} already recorded, ${jobs.length} to run`,
  );

  let next = 0;
  let started = 0;
  let attempted = 0;
  let passed = 0;
  let spent = new D(0);
  let stopped: RunDaySummary["stopped"];

  const worker = async (): Promise<void> => {
    while (stopped === undefined) {
      if (input.maxAnswers !== undefined && started >= input.maxAnswers) return;
      const job = jobs[next++];
      if (job === undefined) return;
      started += 1;
      try {
        const rec = await runAnswer({
          ledger: input.ledger,
          seat: job.seat,
          instance: job.instance,
          bundle: prompts.get(job.instance.id) as NonNullable<ReturnType<typeof buildPrompt>>,
          window: input.window,
          daySha256: input.daySha256,
          part,
          ...(input.now !== undefined ? { now: input.now } : {}),
        });
        input.records.append(rec);
        attempted += 1;
        if (rec.passed) passed += 1;
        spent = spent.plus(rec.usd);
        log(
          `${rec.passed ? "pass" : "FAIL"} ${job.instance.id} ${job.seat.modelId} $${roundHalfUp(new D(rec.usd), 4)}${rec.primary_failure !== undefined ? ` (${rec.primary_failure})` : ""}`,
        );
      } catch (err) {
        if (err instanceof SpendStopped) {
          stopped = { code: err.code, reason: err.reason, provider: err.provider };
          log(`STOPPED by the spend guard: ${err.message}`);
          return;
        }
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const complete = stopped === undefined && alreadyRecorded + attempted === planned;
  let seedRevealed = false;
  if (complete && part === "snapshot" && planned > 0) {
    input.seeds.reveal(input.window);
    seedRevealed = true;
  }
  return {
    window: input.window,
    part,
    planned,
    alreadyRecorded,
    attempted,
    passed,
    usd: spent.toFixed(),
    unservable,
    ...(stopped !== undefined ? { stopped } : {}),
    complete,
    seedRevealed,
  };
}

/** Writes the three tables for a window, as markdown, into `dir` (default: the private tables directory). Returns the files written. */
export function writeTables(
  records: RecordStore,
  window: string,
  part: "snapshot" | "dry-run" = "snapshot",
  dir: string = tablesDir(),
): string[] {
  const all: AnswerRecord[] = records
    .windows()
    .flatMap((w) => records.forWindow(w))
    .filter((r) => r.part === part);
  mkdirSync(dir, { recursive: true });
  const files = [
    [`daily-${part}-${window}.md`, dailyTable(all, window)],
    [`cumulative-${part}.md`, cumulativeTable(all)],
    [`failures-${part}-${window}.md`, failureReport(all, window)],
  ] as const;
  for (const [name, text] of files) writeFileSync(`${dir}/${name}`, text);
  return files.map(([name]) => `${dir}/${name}`);
}
