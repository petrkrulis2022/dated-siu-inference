import type { ModelRegistryEntry } from "../types/generated/model-registry-entry.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import schema from "../../schemas/model-registry-entry.schema.json" with { type: "json" };
import type { ValidationResult } from "./types.js";

const validateFn = ajv.compile<ModelRegistryEntry>(schema);

export function validateModelRegistryEntry(data: unknown): ValidationResult<ModelRegistryEntry> {
  if (validateFn(data)) {
    return { valid: true, data: data as ModelRegistryEntry };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
