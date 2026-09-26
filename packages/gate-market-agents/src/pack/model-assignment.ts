import type { ModelRegistryEntry } from "@touchstone/sdk";
import type { AgentId } from "../identity/resolve.js";

/**
 * Spec §12.2a's two fields, "never one": `reasoningModel` (every agent — what it thinks with)
 * and `capacityModel` (issuers only — what serves redemptions of the claims they issue). Spec
 * §12.2a itself only requires "only admitted, priced models" — no tier restriction — so any
 * registered, priced model is assignable, not only `tier: "frontier"` (that was this project's
 * own earlier default, relaxed 2026-09-25 for WP-7's P5 delegation test, which specifically needs
 * a weaker, non-frontier model assignable to ORCHESTRATOR).
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

/** Throws, never guesses, for a model absent from the registry — the same "throws, never warns"
 * convention `pack/validate.ts` and `budget/model-prices.ts` already use for a real-dollar/real-run
 * mistake.
 *
 * Family is `provider` for a frontier/mid-tier entry (already a clean 1:1 with the real developer
 * — anthropic/openai/google/xai, confirmed against the current registry) but `provider` alone is
 * wrong for the open-weight-hosted tier: every one of those entries is `provider: "openrouter"`
 * regardless of which real lab trained the weights, which would wrongly treat e.g. DeepSeek and
 * Mistral as the same family. `model_string`'s own prefix before the first "/" is the real
 * developer for that tier (confirmed against every current open-weight-hosted entry: "deepseek",
 * "meta-llama", "mistralai", "qwen") and is used instead whenever present. */
export function familyFor(modelId: string, registry: readonly ModelRegistryEntry[]): string {
  const entry = registry.find((r) => r.id === modelId);
  if (!entry) {
    throw new ModelAssignmentError(`"${modelId}" is not a registered model.`);
  }
  const slashIndex = entry.model_string.indexOf("/");
  return slashIndex === -1 ? entry.provider : entry.model_string.slice(0, slashIndex);
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
  // Confirms both are real, registered models too (throws via familyFor if not) — capacityModel
  // isn't otherwise validated above since it never feeds familyOf.
  familyFor(issuerACapacity, registry);
  familyFor(issuerBCapacity, registry);
}
