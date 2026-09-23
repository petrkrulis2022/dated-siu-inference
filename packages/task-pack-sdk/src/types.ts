/**
 * The pack interface, spec §14.2: five things a task pack must provide, and nothing else about
 * the bench needs to know what the task is. `TSubmission`/`TReference` are left generic
 * deliberately — this package must not know the shape gate-hardening (or any other pack) uses
 * for a submission or a reference instance, only that a pack declares one consistently.
 */

export interface GateResult {
  accept: boolean;
  reason: string;
}

/**
 * `gate` must be deterministic and must not call a model — spec §14.2 rule 3 is explicit this is
 * non-negotiable: "a pack whose gate needs a judge cannot be run on this bench, by design." This
 * type alone can't enforce that at compile time; `assertNoNetworkImports` (below) enforces the
 * network half at test time, and "no model call" is a review discipline each pack's own tests
 * must uphold, the same way `@touchstone/task-pack-gate-hardening`'s executor does today.
 */
export type Gate<TSubmission, TReference> = (
  submission: TSubmission,
  reference: TReference,
) => Promise<GateResult>;

export interface TaskPackFixtures<TSubmission, TReference> {
  reference: TReference;
  knownGood: TSubmission;
  adversarial: readonly TSubmission[];
}

export interface TaskPack<TSubmission = unknown, TReference = unknown> {
  name: string;
  /** Which agent roles this pack needs. Left as `string` (not `AgentId`) deliberately — this
   * package sits below the bench (`@touchstone/gate-market-agents`) in the dependency graph, so
   * it cannot import the bench's own role type without creating a cycle. */
  roles: readonly string[];
  /** What one job is, and its class — spec's own "work_unit" field. */
  workUnit: string;
  gate: Gate<TSubmission, TReference>;
  fixtures: TaskPackFixtures<TSubmission, TReference>;
  /** Metric names this pack reports at the end (spec's own "metrics.yaml" field) — just the
   * names here; a pack's own metrics computation lives in the pack, not in this shared type. */
  metrics: readonly string[];
}
