import type { Receipt } from "../types/generated/receipt.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import schema from "../../schemas/receipt.schema.json" with { type: "json" };
import type { ValidationResult } from "./types.js";

const validateFn = ajv.compile<Receipt>(schema);

export function validateReceipt(data: unknown): ValidationResult<Receipt> {
  if (validateFn(data)) {
    return { valid: true, data: data as Receipt };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
