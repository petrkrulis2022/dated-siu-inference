import { createRequire } from "node:module";
import type { GradeResult, TaskInstance } from "../types.js";
import { T1_SCHEMA, type T1Expected } from "./generate.js";

// Same ajv/NodeNext ESM interop issue documented in @datum/sdk's ajv-instance.ts.
const require = createRequire(import.meta.url);
const Ajv = require("ajv").default as typeof import("ajv").default;
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(T1_SCHEMA);

/** Handles the common case of a model wrapping its JSON answer in a ```json fence anyway. */
function extractJson(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fence stripping
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function gradeT1(
  instance: TaskInstance<T1Expected>,
  rawResponse: string,
): Promise<GradeResult> {
  const parsed = extractJson(rawResponse);
  if (parsed === undefined) {
    return { passed: false, reason: "Response did not parse as JSON." };
  }

  if (!validate(parsed)) {
    const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`);
    return { passed: false, reason: `Schema validation failed: ${errors.join("; ")}` };
  }

  const obj = parsed as unknown as Record<string, unknown>;
  const mismatches: string[] = [];
  for (const [key, expectedValue] of Object.entries(instance.expected)) {
    if (obj[key] !== expectedValue) {
      mismatches.push(
        `${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(obj[key])}`,
      );
    }
  }

  if (mismatches.length > 0) {
    return { passed: false, reason: `Field mismatches: ${mismatches.join("; ")}` };
  }

  return { passed: true };
}
