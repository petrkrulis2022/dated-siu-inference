import type { RunRecord } from "../types/generated/run-record.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import schema from "../../schemas/run-record.schema.json" with { type: "json" };
import type { ValidationResult } from "./types.js";

const validateFn = ajv.compile<RunRecord>(schema);

export function validateRunRecord(data: unknown): ValidationResult<RunRecord> {
  if (validateFn(data)) {
    return { valid: true, data: data as RunRecord };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
