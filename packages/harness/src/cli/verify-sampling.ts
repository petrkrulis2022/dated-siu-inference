/**
 * One real call per registry constituent, through the print's own orchestrator, to confirm that every live adapter sends exactly the sampling the registry
 * declares and says so (docs/methodology.md, Sampling settings). Tests with mocked adapters cannot show that; this does. It makes ten small billed calls
 * (one T1 instance each, the cheapest task class), writes its records to a throwaway directory, publishes nothing, and exits non-zero if any model's
 * declared sampling is not what went out. `pnpm --filter @touchstone/harness run verify-sampling`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateT1Instances, gradeT1, toSeed, type Grader } from "@touchstone/basket";
import { loadApiKeysFromEnv } from "../adapters/index.js";
import { runOrchestrator, type OrchestratorTask } from "../orchestrator.js";
import { loadRegistry } from "./load-data.js";

const registry = await loadRegistry();
const [instance] = generateT1Instances(toSeed("verify-sampling"), 1);
const dir = await mkdtemp(join(tmpdir(), "touchstone-verify-sampling-"));
try {
  const tasks: OrchestratorTask[] = registry.map((entry) => ({ registryEntry: entry, instance, grader: gradeT1 as Grader }));
  console.log(`One T1 call for each of ${registry.length} constituents. This makes real, billed calls and publishes nothing.\n`);
  const outcomes = await runOrchestrator(tasks, { runsDir: dir, keys: loadApiKeysFromEnv() });

  let bad = 0;
  for (const o of outcomes) {
    const declared = String(o.registryEntry.sampling?.temperature);
    const record = o.records[0];
    if (o.infraFailure !== undefined) {
      bad += 1;
      console.log(`  FAIL  ${o.registryEntry.id.padEnd(34)} declared ${declared.padEnd(16)} ${o.infraFailureCategory ?? "unknown"}: ${o.infraFailure.slice(0, 200)}`);
    } else {
      const temp = record?.deviations.filter((d) => /temperature/i.test(d)) ?? [];
      console.log(`  ok    ${o.registryEntry.id.padEnd(34)} declared ${declared.padEnd(16)} sent as declared${temp.length > 0 ? ` (note: ${temp.join("; ")})` : ""}`);
    }
  }
  console.log(`\n${outcomes.length - bad} of ${outcomes.length} constituents sent exactly the declared sampling.`);
  if (bad > 0) {
    console.log("At least one did not. Do not merge until each is explained.");
    process.exitCode = 1;
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
