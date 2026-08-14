import type { PriceSnapshot } from "../types/generated/price-snapshot.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import { loadSchema } from "./load-schema.js";
import type { ValidationResult } from "./types.js";

const schema = loadSchema("../../schemas/price-snapshot.schema.json", import.meta.url);
const validateFn = ajv.compile(schema);

export function validatePriceSnapshot(data: unknown): ValidationResult<PriceSnapshot> {
  if (validateFn(data)) {
    return { valid: true, data: data as PriceSnapshot };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
