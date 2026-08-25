import type { TouchstoneQuote } from "../types/generated/datum-quote.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import schema from "../../schemas/datum-quote.schema.json" with { type: "json" };
import type { ValidationResult } from "./types.js";

const validateFn = ajv.compile<TouchstoneQuote>(schema);

export function validateTouchstoneQuote(data: unknown): ValidationResult<TouchstoneQuote> {
  if (validateFn(data)) {
    return { valid: true, data: data as TouchstoneQuote };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
