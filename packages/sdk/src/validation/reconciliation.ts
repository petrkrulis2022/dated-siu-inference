import type { ReconciliationRecord } from "../types/generated/reconciliation.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import schema from "../../schemas/reconciliation.schema.json" with { type: "json" };
import type { ValidationResult } from "./types.js";

const validateFn = ajv.compile<ReconciliationRecord>(schema);

export function validateReconciliation(data: unknown): ValidationResult<ReconciliationRecord> {
  if (validateFn(data)) {
    return { valid: true, data: data as ReconciliationRecord };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
