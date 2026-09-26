import { describe, expect, it } from "vitest";
import type { ModelRegistryEntry } from "@touchstone/sdk";
import { ModelAssignmentError, familyFor, validateModelAssignment, type ModelAssignments } from "./model-assignment.js";

function frontierEntry(id: string, provider: string): ModelRegistryEntry {
  return {
    id,
    provider,
    endpoint: `https://api.${provider}.example/v1`,
    model_string: id,
    tier: "frontier",
    open_weights: false,
    host: provider,
  };
}

const REGISTRY: ModelRegistryEntry[] = [
  frontierEntry("claude-sonnet-5", "anthropic"),
  frontierEntry("gpt-5.1", "openai"),
  frontierEntry("gemini-3.1-pro-preview", "google"),
  frontierEntry("grok-4.6", "xai"),
  {
    id: "mistral-small-3.2-24b-instruct",
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model_string: "mistralai/mistral-small-3.2-24b-instruct",
    tier: "open-weight-hosted",
    open_weights: true,
    host: "parasail",
  },
];

const VALID_ASSIGNMENTS: ModelAssignments = {
  "ISSUER-A": { reasoningModel: "grok-4.6", capacityModel: "grok-4.6" },
  "ISSUER-B": { reasoningModel: "grok-4.6", capacityModel: "gemini-3.1-pro-preview" },
  ORCHESTRATOR: { reasoningModel: "gpt-5.1" },
  "WORKER-CODE": { reasoningModel: "claude-sonnet-5" },
  "WORKER-EXTRACT": { reasoningModel: "gemini-3.1-pro-preview" },
  HEDGER: { reasoningModel: "gpt-5.1" },
};

describe("familyFor", () => {
  it("returns the provider for a real frontier-tier model", () => {
    expect(familyFor("claude-sonnet-5", REGISTRY)).toBe("anthropic");
  });

  it("throws for an unregistered model", () => {
    expect(() => familyFor("nonexistent-model", REGISTRY)).toThrow(ModelAssignmentError);
  });

  it("accepts a non-frontier, open-weight-hosted model — relaxed 2026-09-25 for WP-7's P5 delegation test", () => {
    expect(() => familyFor("mistral-small-3.2-24b-instruct", REGISTRY)).not.toThrow();
  });

  it("derives family from model_string's own prefix for open-weight-hosted models, not the shared 'openrouter' provider", () => {
    const registryWithMultipleOpenWeight: ModelRegistryEntry[] = [
      ...REGISTRY,
      {
        id: "deepseek-v3.2",
        provider: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model_string: "deepseek/deepseek-v3.2",
        tier: "open-weight-hosted",
        open_weights: true,
        host: "deepinfra",
      },
    ];
    const mistralFamily = familyFor("mistral-small-3.2-24b-instruct", registryWithMultipleOpenWeight);
    const deepseekFamily = familyFor("deepseek-v3.2", registryWithMultipleOpenWeight);
    expect(mistralFamily).toBe("mistralai");
    expect(deepseekFamily).toBe("deepseek");
    // The real property this fix exists for: both share provider "openrouter" but must not be
    // treated as the same family — that's the bug relying on `provider` alone would reintroduce.
    expect(mistralFamily).not.toBe(deepseekFamily);
  });
});

describe("validateModelAssignment", () => {
  it("accepts a real, valid assignment — the actual one this run uses", () => {
    expect(() => validateModelAssignment(VALID_ASSIGNMENTS, REGISTRY)).not.toThrow();
  });

  it("blocks WORKER-CODE/WORKER-EXTRACT sharing a model family", () => {
    const assignments: ModelAssignments = {
      ...VALID_ASSIGNMENTS,
      "WORKER-EXTRACT": { reasoningModel: "claude-sonnet-5" },
    };
    expect(() => validateModelAssignment(assignments, REGISTRY)).toThrow(
      /WORKER-CODE and WORKER-EXTRACT share model family/,
    );
  });

  it("blocks deciding agents (orchestrator + both workers) sharing one family", () => {
    const assignments: ModelAssignments = {
      ...VALID_ASSIGNMENTS,
      ORCHESTRATOR: { reasoningModel: "claude-sonnet-5" },
      "WORKER-CODE": { reasoningModel: "claude-sonnet-5" },
      "WORKER-EXTRACT": { reasoningModel: "gpt-5.1" },
    };
    // WORKER-CODE and ORCHESTRATOR now share a family — but rule 1 only checks the
    // WORKER-CODE/WORKER-EXTRACT pair, so this must fail on rule 2 (span >= 2 families), not rule 1.
    expect(() => validateModelAssignment(assignments, REGISTRY)).not.toThrow(
      /WORKER-CODE and WORKER-EXTRACT share/,
    );
  });

  it("does not block two non-adversarial agents sharing a family (scoped to the builder/adversary pair only)", () => {
    // ISSUER-A and ORCHESTRATOR share "grok-4.6"/"gpt-5.1" families arbitrarily in the fixture
    // above already and that's accepted — this test asserts the rule really is scoped, not just
    // that the happy path passes by coincidence.
    const assignments: ModelAssignments = {
      ...VALID_ASSIGNMENTS,
      "ISSUER-A": { reasoningModel: "gpt-5.1", capacityModel: "grok-4.6" },
    };
    expect(() => validateModelAssignment(assignments, REGISTRY)).not.toThrow();
  });

  it("blocks ISSUER-A and ISSUER-B sharing a capacityModel", () => {
    const assignments: ModelAssignments = {
      ...VALID_ASSIGNMENTS,
      "ISSUER-B": { reasoningModel: "grok-4.6", capacityModel: "grok-4.6" },
    };
    expect(() => validateModelAssignment(assignments, REGISTRY)).toThrow(
      /identical capacity models leave the two-issuer comparison/,
    );
  });

  it("blocks a missing capacityModel on either issuer", () => {
    const assignments: ModelAssignments = {
      ...VALID_ASSIGNMENTS,
      "ISSUER-A": { reasoningModel: "grok-4.6" },
    };
    expect(() => validateModelAssignment(assignments, REGISTRY)).toThrow(
      /must each have a capacityModel assigned/,
    );
  });
});
