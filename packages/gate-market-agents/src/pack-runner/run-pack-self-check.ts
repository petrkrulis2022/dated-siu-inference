import type { TaskPack } from "@touchstone/task-pack-sdk";

export interface PackSelfCheckResult {
  packName: string;
  knownGoodAccepted: boolean;
  adversarialRejectedCount: number;
  adversarialTotalCount: number;
  passed: boolean;
}

/**
 * The bench's one, pack-agnostic way to sanity-check any `TaskPack`: run its own declared
 * `fixtures.knownGood` (must be accepted) and every `fixtures.adversarial` entry (must be
 * rejected) through its own `gate()`. This is the function WP-9's second, trivial pack proves
 * runs unmodified — see `pack-runner.test.ts`, which feeds both the real gate-hardening packs and
 * the trivial pack through this exact same function.
 *
 * Sequential, not `Promise.all` — matches `@touchstone/task-pack-gate-hardening`'s own executor,
 * which found live that concurrent sandboxed evaluations intermittently fail under host memory
 * pressure. A generic pack runner has no way to know whether a given pack's `gate()` shares that
 * constraint, so it plays it safe for every pack.
 */
export async function runPackSelfCheck<TSubmission, TReference>(
  pack: TaskPack<TSubmission, TReference>,
): Promise<PackSelfCheckResult> {
  const knownGoodResult = await pack.gate(pack.fixtures.knownGood, pack.fixtures.reference);

  let adversarialRejectedCount = 0;
  for (const submission of pack.fixtures.adversarial) {
    const result = await pack.gate(submission, pack.fixtures.reference);
    if (!result.accept) adversarialRejectedCount++;
  }

  return {
    packName: pack.name,
    knownGoodAccepted: knownGoodResult.accept,
    adversarialRejectedCount,
    adversarialTotalCount: pack.fixtures.adversarial.length,
    passed: knownGoodResult.accept && adversarialRejectedCount === pack.fixtures.adversarial.length,
  };
}
