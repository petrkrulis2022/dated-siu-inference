import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

/**
 * Refuses, by throwing, to let private data land anywhere git would track. Payment records and
 * other bookkeeping go only under a path the repository ignores (data/private/): the repository is
 * public, so a file that is not ignored is one `git add .` away from being published.
 *
 * Asks git itself (`git check-ignore`), so it agrees with every .gitignore rule, works before the
 * file or its directory exists, and refuses a file git already tracks (check-ignore never reports a
 * tracked file as ignored) and any path outside a git repository.
 */
export function assertGitIgnored(path: string): void {
  const target = resolve(path);
  let dir = dirname(target);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  let ignored: boolean;
  try {
    const root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    execFileSync("git", ["-C", root, "check-ignore", "-q", "--", relative(root, target)], { stdio: "ignore" });
    ignored = true;
  } catch {
    ignored = false;
  }
  if (!ignored) throw new Error(`refusing to write ${target}: git does not ignore it (expected a path under data/private/)`);
}
