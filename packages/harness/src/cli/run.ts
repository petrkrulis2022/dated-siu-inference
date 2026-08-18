import {
  generateT1Instances,
  generateT2Instances,
  generateT3Instances,
  gradeT1,
  gradeT2,
  gradeT3,
  toSeed,
  type Grader,
  type TaskClass,
} from "@touchstone/basket";
import { loadApiKeysFromEnv } from "../adapters/index.js";
import { runOrchestrator, type OrchestratorTask } from "../orchestrator.js";
import { loadRegistry } from "./load-data.js";
import { runsDirFor } from "./paths.js";

const printId = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const printSeed = toSeed(printId);

const registry = await loadRegistry();
const keys = loadApiKeysFromEnv();

// Each grader's real type is narrower than the generic `Grader` (e.g. gradeT1 only accepts
// TaskInstance<T1Expected>), so this keyed map isn't assignable to Record<TaskClass, Grader>
// without a cast. It's runtime-sound: `tasks` below always pairs an instance with the
// grader keyed by that same instance's own task_class, never a mismatched pair.
const graders = { T1: gradeT1, T2: gradeT2, T3: gradeT3 } as Record<TaskClass, Grader>;
const instances = [
  ...generateT1Instances(printSeed, 5),
  ...generateT2Instances(printSeed, 5),
  ...generateT3Instances(printSeed, 5),
];

const tasks: OrchestratorTask[] = [];
for (const model of registry) {
  for (const instance of instances) {
    tasks.push({ registryEntry: model, instance, grader: graders[instance.task_class] });
  }
}

console.log(`Running ${tasks.length} (model x instance) pairs for print "${printId}".`);
console.log("This makes real, billed API calls. Run dry-run first if you haven't.");

const outcomes = await runOrchestrator(tasks, { runsDir: runsDirFor(printId), keys });

const passed = outcomes.filter((o) => o.passed).length;
const infraFailures = outcomes.filter((o) => o.infraFailure);

console.log(`\nDone: ${passed}/${outcomes.length} passed.`);
if (infraFailures.length > 0) {
  console.log(
    `${infraFailures.length} instance(s) had an infrastructure failure (no run record written):`,
  );
  for (const outcome of infraFailures) {
    console.log(
      `  ${outcome.registryEntry.id} / ${outcome.instance.instance_id}: ${outcome.infraFailure}`,
    );
  }
}
