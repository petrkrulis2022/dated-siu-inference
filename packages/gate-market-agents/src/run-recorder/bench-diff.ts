/** Spec §14.4: "Add a `diff` command: two run ids in, a report of what differed in
 * configuration and what differed in outcome, side by side." Pure and testable independently of
 * any filesystem — `cli/bench-diff.ts` is the thin wrapper that reads two runs' `manifest.yaml`
 * and `metrics.json` and calls this. */

export interface FieldDiff {
  path: string;
  a: unknown;
  b: unknown;
}

export interface BenchDiffReport {
  configDifferences: FieldDiff[];
  outcomeDifferences: FieldDiff[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diffValues(a: unknown, b: unknown, path: string): FieldDiff[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const diffs: FieldDiff[] = [];
    for (const key of keys) {
      diffs.push(...diffValues(a[key], b[key], path ? `${path}.${key}` : key));
    }
    return diffs;
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  return [{ path: path || "(root)", a, b }];
}

export function computeBenchDiff(
  manifestA: unknown,
  manifestB: unknown,
  metricsA: unknown,
  metricsB: unknown,
): BenchDiffReport {
  return {
    configDifferences: diffValues(manifestA, manifestB, ""),
    outcomeDifferences: diffValues(metricsA, metricsB, ""),
  };
}

function formatSection(title: string, diffs: FieldDiff[]): string[] {
  const lines = [title];
  if (diffs.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  for (const d of diffs) {
    lines.push(`  ${d.path}: ${JSON.stringify(d.a)}  ->  ${JSON.stringify(d.b)}`);
  }
  return lines;
}

export function formatBenchDiffReport(report: BenchDiffReport, runIdA: string, runIdB: string): string {
  return [
    `bench diff ${runIdA} ${runIdB}`,
    "",
    ...formatSection("Config differences (manifest.yaml):", report.configDifferences),
    "",
    ...formatSection("Outcome differences (metrics.json):", report.outcomeDifferences),
  ].join("\n");
}
