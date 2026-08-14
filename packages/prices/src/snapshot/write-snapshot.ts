import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PriceSnapshot } from "@datum/sdk";
import { validatePriceSnapshot } from "@datum/sdk";

export function snapshotFileName(snapshot: PriceSnapshot): string {
  const safeTimestamp = snapshot.timestamp.replace(/:/g, "-");
  return `price-snapshot-${snapshot.source}-${safeTimestamp}.json`;
}

/**
 * Writes a price snapshot to disk. Snapshots are immutable — build1-spec.md §5 says they
 * are "stored with a timestamp and never overwritten." Refuses to clobber an existing file
 * rather than silently overwriting one.
 */
export async function writeSnapshot(registryDir: string, snapshot: PriceSnapshot): Promise<string> {
  const result = validatePriceSnapshot(snapshot);
  if (!result.valid) {
    throw new Error(`Refusing to write an invalid snapshot: ${result.errors.join("; ")}`);
  }

  await mkdir(registryDir, { recursive: true });
  const filePath = join(registryDir, snapshotFileName(snapshot));

  const alreadyExists = await access(filePath)
    .then(() => true)
    .catch(() => false);
  if (alreadyExists) {
    throw new Error(`Refusing to overwrite existing immutable snapshot: ${filePath}`);
  }

  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  return filePath;
}
