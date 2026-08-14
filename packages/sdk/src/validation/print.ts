import type { Print } from "../types/generated/print.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import { loadSchema } from "./load-schema.js";
import type { ValidationResult } from "./types.js";

const schema = loadSchema("../../schemas/print.schema.json", import.meta.url);
const validateFn = ajv.compile(schema);

export function validatePrint(data: unknown): ValidationResult<Print> {
  if (validateFn(data)) {
    return { valid: true, data: data as Print };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
