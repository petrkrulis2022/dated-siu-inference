import { resolve } from "node:path";

/** pnpm always runs package scripts with cwd = the package directory. */
export function repoRoot(): string {
  return resolve(process.cwd(), "../..");
}

export function registryDir(): string {
  return resolve(repoRoot(), "data/registry");
}

export function registryModelsPath(): string {
  return resolve(registryDir(), "models.json");
}

export function runsDirFor(printId: string): string {
  return resolve(repoRoot(), "data/runs", printId);
}
