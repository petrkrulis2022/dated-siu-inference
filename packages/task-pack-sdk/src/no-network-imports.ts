/**
 * Spec §14.2 rule 3: a pack's `gate()` must have no network in the loop. This checks the static
 * import specifiers of one source file — the module that actually exports a pack's `gate`
 * function — against a blocklist of network/DB client modules and Node's own network builtins.
 *
 * Disclosed limitation: this only scans the given file's own `import ... from "..."` statements,
 * not its transitive import graph, and not dynamic `import()`/`require()` calls. That's enough to
 * catch a gate module directly reaching for a client library (the realistic way this would
 * happen), but it is a real, honest limit, not a full taint-analysis — a determined author could
 * still route around it through an indirection this scan doesn't follow.
 */
const DISALLOWED_IMPORT_PATTERNS: RegExp[] = [
  /^node:(http|https|net|dgram|dns|tls)$/,
  /^(http|https|net|dgram|dns|tls)$/,
  /^(node-)?fetch$/,
  /^axios$/,
  /^undici$/,
  /^(pg|mysql2?|mongodb|redis|ioredis|knex|prisma)$/,
];

export function findDisallowedImports(sourceText: string): string[] {
  const specifiers = [...sourceText.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  return specifiers.filter((spec) => DISALLOWED_IMPORT_PATTERNS.some((pattern) => pattern.test(spec)));
}

export function assertNoNetworkImports(sourceText: string, filePath: string): void {
  const disallowed = findDisallowedImports(sourceText);
  if (disallowed.length > 0) {
    throw new Error(
      `${filePath} imports a disallowed network/client module: ${disallowed.join(", ")} — a pack's gate() must have no network in the loop (spec §14.2 rule 3).`,
    );
  }
}
