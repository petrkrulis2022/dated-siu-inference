export const BASKET_VERSION = "SIU-2026a";

export interface TaskClassSpec {
  weight: string;
  instancesPerPrint: number;
}

/** build1-spec.md §3 — weights are decimal strings, consistent with the rest of the pipeline's money maths. */
export const TASK_CLASSES: Record<"T1" | "T2" | "T3", TaskClassSpec> = {
  T1: { weight: "0.50", instancesPerPrint: 5 },
  T2: { weight: "0.30", instancesPerPrint: 5 },
  T3: { weight: "0.20", instancesPerPrint: 5 },
};
