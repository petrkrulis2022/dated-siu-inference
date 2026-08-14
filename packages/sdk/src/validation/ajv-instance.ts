import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";

// ajv's CJS build has no clean single `module.exports = Ajv`, so under strict NodeNext
// ESM interop the static `import` form resolves to the whole module namespace instead
// of the constructable class. require() gets the real runtime shape directly.
const require = createRequire(import.meta.url);
const Ajv = require("ajv").default as typeof import("ajv").default;

export const ajv = new Ajv({ allErrors: true });

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) {
    return ["unknown validation error"];
  }
  return errors.map((err) => `${err.instancePath || "(root)"} ${err.message ?? "invalid"}`);
}
