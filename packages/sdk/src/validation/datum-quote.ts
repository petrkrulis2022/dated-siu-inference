import type { TouchstoneQuote } from "../types/generated/datum-quote.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import { loadSchema } from "./load-schema.js";
import type { ValidationResult } from "./types.js";

const schema = loadSchema("../../schemas/datum-quote.schema.json", import.meta.url);
const validateFn = ajv.compile(schema);

export function validateTouchstoneQuote(data: unknown): ValidationResult<TouchstoneQuote> {
  if (validateFn(data)) {
    return { valid: true, data: data as TouchstoneQuote };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
