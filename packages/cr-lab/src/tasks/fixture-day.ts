/**
 * A day of FIXTURE data, built by running the real daily plan against the fixtures backend into a temporary store, then loading it as the generators and solvers do. For tests and for
 * trying the task code before there is a live day to try it on. Nothing here is Blockworks data.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataDesk } from "../data-desk/desk.js";
import { FixtureBackend } from "../data-desk/fixtures/backend.js";
import { FIXTURE_AS_OF, type FixtureWorld } from "../data-desk/fixtures/world.js";
import { RateGovernor } from "../data-desk/governor.js";
import { runDailyPlan, type PlanResult } from "../data-desk/snapshot-plan.js";
import { SnapshotStore } from "../data-desk/snapshots.js";
import { loadDay, type DayData } from "./day-data.js";

export interface FixtureDay {
  day: DayData;
  world: FixtureWorld;
  store: SnapshotStore;
  backend: FixtureBackend;
  plan: PlanResult;
  root: string;
  cleanup: () => void;
}

export async function fixtureDay(
  window: string = FIXTURE_AS_OF,
  faults: Record<string, number> = {},
  lagByModel: Record<string, number> = {},
): Promise<FixtureDay> {
  const root = mkdtempSync(join(tmpdir(), "cr-day-"));
  const backend = new FixtureBackend({ faults, lagByModel });
  const store = new SnapshotStore({
    privateRoot: join(root, "private"),
    manifestDir: join(root, "manifests"),
    backend: "fixtures",
  });
  const fast = { minIntervalMs: 0, baseBackoffMs: 1, maxBackoffMs: 1, maxRetries: 1 };
  const desk = new DataDesk({
    backend,
    store,
    governor: new RateGovernor({ overrides: { "data-api": fast, "token-unlocks": fast } }),
  });
  const plan = await runDailyPlan(desk, { window });
  return {
    day: loadDay(store, window),
    world: backend.world,
    store,
    backend,
    plan,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
