import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PriceSnapshot } from "@datum/sdk";

export interface PriceDiffEntry {
  model_id: string;
  field: "price_in_usd_per_1m" | "price_out_usd_per_1m";
  from: string;
  to: string;
}

export interface PriceDiffResult {
  previous: { snapshot_id: string; timestamp: string };
  current: { snapshot_id: string; timestamp: string };
  changes: PriceDiffEntry[];
  added: string[];
  removed: string[];
}

async function listSnapshotFiles(registryDir: string, source: string): Promise<string[]> {
  const files = await readdir(registryDir).catch(() => [] as string[]);
  return files
    .filter((f) => f.startsWith(`price-snapshot-${source}-`) && f.endsWith(".json"))
    .sort();
}

/** Reports changes between the two most recent snapshots for a source. Null if fewer than two exist. */
export async function diffLatestSnapshots(
  registryDir: string,
  source: "openrouter" | "litellm",
): Promise<PriceDiffResult | null> {
  const files = await listSnapshotFiles(registryDir, source);
  if (files.length < 2) {
    return null;
  }
  const [previousFile, currentFile] = files.slice(-2);
  const previous = JSON.parse(
    await readFile(join(registryDir, previousFile), "utf-8"),
  ) as PriceSnapshot;
  const current = JSON.parse(
    await readFile(join(registryDir, currentFile), "utf-8"),
  ) as PriceSnapshot;

  const prevById = new Map([...previous.entries].map((e) => [e.model_id, e]));
  const currById = new Map([...current.entries].map((e) => [e.model_id, e]));

  const changes: PriceDiffEntry[] = [];
  for (const [modelId, curr] of currById) {
    const prev = prevById.get(modelId);
    if (!prev) continue;
    if (prev.price_in_usd_per_1m !== curr.price_in_usd_per_1m) {
      changes.push({
        model_id: modelId,
        field: "price_in_usd_per_1m",
        from: prev.price_in_usd_per_1m,
        to: curr.price_in_usd_per_1m,
      });
    }
    if (prev.price_out_usd_per_1m !== curr.price_out_usd_per_1m) {
      changes.push({
        model_id: modelId,
        field: "price_out_usd_per_1m",
        from: prev.price_out_usd_per_1m,
        to: curr.price_out_usd_per_1m,
      });
    }
  }

  return {
    previous: { snapshot_id: previous.snapshot_id, timestamp: previous.timestamp },
    current: { snapshot_id: current.snapshot_id, timestamp: current.timestamp },
    changes,
    added: [...currById.keys()].filter((id) => !prevById.has(id)),
    removed: [...prevById.keys()].filter((id) => !currById.has(id)),
  };
}

export function formatDiffReport(diff: PriceDiffResult | null): string {
  if (!diff) {
    return "Fewer than two snapshots exist for this source — nothing to diff yet.";
  }
  const lines: string[] = [`Comparing ${diff.previous.timestamp} -> ${diff.current.timestamp}`];
  if (diff.changes.length === 0 && diff.added.length === 0 && diff.removed.length === 0) {
    lines.push("No changes.");
    return lines.join("\n");
  }
  for (const c of diff.changes) {
    lines.push(`  ~ ${c.model_id} ${c.field}: ${c.from} -> ${c.to}`);
  }
  for (const id of diff.added) {
    lines.push(`  + ${id} (new)`);
  }
  for (const id of diff.removed) {
    lines.push(`  - ${id} (dropped)`);
  }
  return lines.join("\n");
}
