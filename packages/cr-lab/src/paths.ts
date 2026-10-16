/**
 * Where the Blockworks trial (lab series CR, `docs/marketplace_plan.md` §16) may keep what.
 *
 * The data is licensed and this repository is public, so there are exactly two homes (D71):
 *  - `PRIVATE_DIR` (`data/private/blockworks/`, gitignored): every Blockworks response, snapshot, raw model output that may restate data, and the MCP login.
 *  - `CR_PUBLIC_DIR` (`data/lab/cr/`, committed): only what carries no Blockworks data: the day's manifest of snapshot hashes, the spend ledger, budgets.
 * Code never builds a private path by hand: `privatePath` is the one way, and it refuses a path that would leave the private directory.
 */
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root. This file is `packages/cr-lab/src/paths.ts` (or `dist/paths.js`), three levels below it. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const PRIVATE_DIR_REL = "data/private/blockworks";
export const PRIVATE_DIR = resolve(REPO_ROOT, PRIVATE_DIR_REL);
export const CR_PUBLIC_DIR_REL = "data/lab/cr";
export const CR_PUBLIC_DIR = resolve(REPO_ROOT, CR_PUBLIC_DIR_REL);

/** An absolute path inside `root`. Throws if `segments` are absolute or climb out (`..`). */
export function pathWithin(root: string, ...segments: string[]): string {
  const target = resolve(root, ...segments);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing a path outside ${root}: ${segments.join("/")}`);
  }
  return target;
}

/** An absolute path inside `PRIVATE_DIR`. Throws if `segments` are absolute or climb out (`..`), so a bug cannot write licensed data to a tracked path. */
export function privatePath(...segments: string[]): string {
  try {
    return pathWithin(PRIVATE_DIR, ...segments);
  } catch {
    throw new Error(
      `refusing a path outside the private Blockworks directory (${PRIVATE_DIR_REL}): ${segments.join("/")}`,
    );
  }
}
