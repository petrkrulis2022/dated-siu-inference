import AjvNamespace from "ajv";
import type { ErrorObject } from "ajv";

// ajv's CJS build has no clean single `module.exports = Ajv`, so under strict NodeNext ESM
// interop the static `import` form can resolve to the whole module namespace instead of the
// constructable class, with the real class at `.default`. Unwrapping it this way (rather than
// the createRequire(import.meta.url) trick this used previously) works identically under Node
// and under Cloudflare Workers, which has no real module URLs for createRequire to resolve
// against — confirmed live: the Workers deploy failed at the validation/bundling step with
// "the argument must be a file URL... Received 'undefined'" until this changed.
const Ajv = ((AjvNamespace as unknown as { default?: unknown }).default ?? AjvNamespace) as
  typeof import("ajv").default;

export const ajv = new Ajv({ allErrors: true });

export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) {
    return ["unknown validation error"];
  }
  return errors.map((err) => `${err.instancePath || "(root)"} ${err.message ?? "invalid"}`);
}
