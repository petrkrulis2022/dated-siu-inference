import type { RunManifest } from "../types/generated/run-manifest.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import schema from "../../schemas/run-manifest.schema.json" with { type: "json" };
import type { ValidationResult } from "./types.js";

const validateFn = ajv.compile<RunManifest>(schema);

export function validateRunManifest(data: unknown): ValidationResult<RunManifest> {
  if (validateFn(data)) {
    return { valid: true, data: data as RunManifest };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
