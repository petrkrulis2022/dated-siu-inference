import type { Receipt } from "../types/generated/receipt.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import { loadSchema } from "./load-schema.js";
import type { ValidationResult } from "./types.js";

const schema = loadSchema("../../schemas/receipt.schema.json", import.meta.url);
const validateFn = ajv.compile(schema);

export function validateReceipt(data: unknown): ValidationResult<Receipt> {
  if (validateFn(data)) {
    return { valid: true, data: data as Receipt };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
