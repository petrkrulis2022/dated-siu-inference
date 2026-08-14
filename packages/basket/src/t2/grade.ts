import type { GradeResult, TaskInstance } from "../types.js";
import type { T2Expected } from "./generate.js";

export async function gradeT2(
  instance: TaskInstance<T2Expected>,
  rawResponse: string,
): Promise<GradeResult> {
  const missing = instance.expected.codes.filter((code) => !rawResponse.includes(code));

  if (missing.length > 0) {
    return { passed: false, reason: `Missing planted code(s): ${missing.join(", ")}` };
  }

  return { passed: true };
}
