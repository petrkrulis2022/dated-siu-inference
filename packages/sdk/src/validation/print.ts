import type { Print } from "../types/generated/print.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import schema from "../../schemas/print.schema.json" with { type: "json" };
import type { ValidationResult } from "./types.js";

const validateFn = ajv.compile<Print>(schema);

export function validatePrint(data: unknown): ValidationResult<Print> {
  if (validateFn(data)) {
    return { valid: true, data: data as Print };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
