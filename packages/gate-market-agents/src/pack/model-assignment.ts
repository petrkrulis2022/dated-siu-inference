import type { ModelRegistryEntry } from "@touchstone/sdk";
import type { AgentId } from "../identity/resolve.js";

/**
 * Spec §12.2a's two fields, "never one": `reasoningModel` (every agent — what it thinks with)
 * and `capacityModel` (issuers only — what serves redemptions of the claims they issue). Scoped
 * to `tier: "frontier"` registry entries only, per the run's own "frontier tier model assignment"
 * decision — this also collapses "model family" to that entry's own `provider` field, since every
 * real frontier-tier registry entry today is one model per provider (`familyFor` below would need
 * a real per-model family field instead of `provider` the day a second frontier model shares a
 * provider — checked, not the case as of 2026-09-25).
 */
export interface ModelAssignment {
  reasoningModel: string;
  capacityModel?: string;
}

export type ModelAssignments = Record<AgentId, ModelAssignment>;

export class ModelAssignmentError extends Error {
  constructor(message: string) {
    super(`Model assignment refused (spec §12.2a): ${message}`);
    this.name = "ModelAssignmentError";
  }
}

/** Throws, never guesses, for a model outside the frontier tier or absent from the registry —
 * the same "throws, never warns" convention `pack/validate.ts` and `budget/model-prices.ts`
 * already use for a real-dollar/real-run mistake. */
export function familyFor(modelId: string, registry: readonly ModelRegistryEntry[]): string {
  const entry = registry.find((r) => r.id === modelId);
  if (!entry) {
    throw new ModelAssignmentError(`"${modelId}" is not a registered model.`);
  }
  if (entry.tier !== "frontier") {
    throw new ModelAssignmentError(
      `"${modelId}" is tier "${entry.tier}", not "frontier" — this run's model assignment is ` +
        "scoped to frontier-tier models only.",
    );
  }
  return entry.provider;
}

/**
 * The three blocking rules from spec §12.2a's validator table, enforced directly against a
 * manifest before a run starts — there is no console (WP-10) to enforce them instead. Throws on
 * the first violation found; a "warn" row exists in the spec too (issuers' measured rates should
 * differ materially) but that can only be checked after a real probe, not from the manifest alone,
 * so it isn't attempted here.
 */
export function validateModelAssignment(
  assignments: ModelAssignments,
  registry: readonly ModelRegistryEntry[],
): void {
  const familyOf = (agentId: AgentId): string => familyFor(assignments[agentId].reasoningModel, registry);

  // Rule 1: the builder/adversary pair per class must not share a family. WORKER-CODE and
  // WORKER-EXTRACT are each other's adversary (spec §3: each acts as adversary on the other's
  // class) — scoped to exactly this pair, per the spec's own "scope the first rule carefully"
  // warning against a validator that fires on every same-family pair.
  const codeFamily = familyOf("WORKER-CODE");
  const extractFamily = familyOf("WORKER-EXTRACT");
  if (codeFamily === extractFamily) {
    throw new ModelAssignmentError(
      `WORKER-CODE and WORKER-EXTRACT share model family "${codeFamily}" — each is the other's ` +
        "adversary, and an attacker sharing the gate-writer's family shares its blind spots.",
    );
  }

  // Rule 2: deciding agents (orchestrator + workers) span at least two families — F1 threat (b).
  const decidingFamilies = new Set([familyOf("ORCHESTRATOR"), codeFamily, extractFamily]);
  if (decidingFamilies.size < 2) {
    throw new ModelAssignmentError(
      "ORCHESTRATOR, WORKER-CODE and WORKER-EXTRACT must span at least two model families — " +
        "one family is one disposition sampled repeatedly, not independent choices.",
    );
  }

  // Rule 3: the two issuers' capacityModel must both be present and differ.
  const issuerACapacity = assignments["ISSUER-A"].capacityModel;
  const issuerBCapacity = assignments["ISSUER-B"].capacityModel;
  if (!issuerACapacity || !issuerBCapacity) {
    throw new ModelAssignmentError("ISSUER-A and ISSUER-B must each have a capacityModel assigned.");
  }
  if (issuerACapacity === issuerBCapacity) {
    throw new ModelAssignmentError(
      `ISSUER-A and ISSUER-B both serve redemptions with "${issuerACapacity}" — identical ` +
        "capacity models leave the two-issuer comparison with nothing to compare.",
    );
  }
  // Confirms both are real, registered, frontier-tier models too (throws via familyFor if not) —
  // capacityModel isn't otherwise validated above since it never feeds familyOf.
  familyFor(issuerACapacity, registry);
  familyFor(issuerBCapacity, registry);
}
