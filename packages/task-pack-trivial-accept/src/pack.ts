import type { GateResult, TaskPack } from "@touchstone/task-pack-sdk";

export interface TrivialSubmission {
  text: string;
}

export interface TrivialReference {
  requiredSubstring: string;
}

async function trivialAcceptGate(
  submission: TrivialSubmission,
  reference: TrivialReference,
): Promise<GateResult> {
  const accept = submission.text.includes(reference.requiredSubstring);
  return {
    accept,
    reason: accept
      ? `submission text contains the required substring "${reference.requiredSubstring}"`
      : `submission text does not contain the required substring "${reference.requiredSubstring}"`,
  };
}

const REFERENCE: TrivialReference = { requiredSubstring: "APPROVED" };

export const TRIVIAL_ACCEPT_PACK: TaskPack<TrivialSubmission, TrivialReference> = {
  name: "trivial-accept",
  roles: ["WORKER-CODE"],
  workUnit: "Produce text containing the configured required substring.",
  gate: trivialAcceptGate,
  fixtures: {
    reference: REFERENCE,
    knownGood: { text: "This work is APPROVED for delivery." },
    adversarial: [{ text: "This work has no magic word." }],
  },
  metrics: ["accept_rate"],
};
