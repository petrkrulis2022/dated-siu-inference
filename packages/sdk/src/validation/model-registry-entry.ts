import type { ModelRegistryEntry } from "../types/generated/model-registry-entry.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import { loadSchema } from "./load-schema.js";
import type { ValidationResult } from "./types.js";

const schema = loadSchema("../../schemas/model-registry-entry.schema.json", import.meta.url);
const validateFn = ajv.compile(schema);

export function validateModelRegistryEntry(data: unknown): ValidationResult<ModelRegistryEntry> {
  if (validateFn(data)) {
    return { valid: true, data: data as ModelRegistryEntry };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
