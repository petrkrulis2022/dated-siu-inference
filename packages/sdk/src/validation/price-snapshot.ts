import type { PriceSnapshot } from "../types/generated/price-snapshot.schema.js";
import { ajv, formatAjvErrors } from "./ajv-instance.js";
import schema from "../../schemas/price-snapshot.schema.json" with { type: "json" };
import type { ValidationResult } from "./types.js";

const validateFn = ajv.compile<PriceSnapshot>(schema);

export function validatePriceSnapshot(data: unknown): ValidationResult<PriceSnapshot> {
  if (validateFn(data)) {
    return { valid: true, data: data as PriceSnapshot };
  }
  return { valid: false, errors: formatAjvErrors(validateFn.errors) };
}
