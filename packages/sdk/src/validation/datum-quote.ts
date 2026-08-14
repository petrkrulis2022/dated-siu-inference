import type { DatumQuote } from "../types/generated/datum-quote.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import { loadSchema } from "./load-schema.js";
import type { ValidationResult } from "./types.js";

const schema = loadSchema("../../schemas/datum-quote.schema.json", import.meta.url);
const validateFn = ajv.compile(schema);

export function validateDatumQuote(data: unknown): ValidationResult<DatumQuote> {
  if (validateFn(data)) {
    return { valid: true, data: data as DatumQuote };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
