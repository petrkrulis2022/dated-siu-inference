import type { RunRecord } from "../types/generated/run-record.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import { loadSchema } from "./load-schema.js";
import type { ValidationResult } from "./types.js";

const schema = loadSchema("../../schemas/run-record.schema.json", import.meta.url);
const validateFn = ajv.compile(schema);

export function validateRunRecord(data: unknown): ValidationResult<RunRecord> {
  if (validateFn(data)) {
    return { valid: true, data: data as RunRecord };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
