import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GpuRateSnapshot } from "./gpu-rate-snapshot.js";

export function gpuRateSnapshotFileName(snapshot: GpuRateSnapshot): string {
  const safeTimestamp = snapshot.timestamp.replace(/:/g, "-");
  return `gpu-rate-snapshot-${safeTimestamp}.json`;
}

/** Same immutability rule as price snapshots: never overwrite an existing file. */
export async function writeGpuRateSnapshot(
  registryDir: string,
  snapshot: GpuRateSnapshot,
): Promise<string> {
  await mkdir(registryDir, { recursive: true });
  const filePath = join(registryDir, gpuRateSnapshotFileName(snapshot));

  const alreadyExists = await access(filePath)
    .then(() => true)
    .catch(() => false);
  if (alreadyExists) {
    throw new Error(`Refusing to overwrite existing immutable snapshot: ${filePath}`);
  }

  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  return filePath;
}
