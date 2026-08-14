import { resolve } from "node:path";

/** pnpm always runs package scripts with cwd = the package directory. */
export function repoRoot(): string {
  return resolve(process.cwd(), "../..");
}

export function registryModelsPath(): string {
  return resolve(repoRoot(), "data/registry/models.json");
}

export function registryDir(): string {
  return resolve(repoRoot(), "data/registry");
}
