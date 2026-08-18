import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Print } from "@touchstone/sdk";
import { loadPrint } from "@touchstone/print";

export interface GetIndexInput {
  version?: string;
  date?: string;
}

/**
 * get_index(version?, date?) — build1-spec.md §9: free, "signed print." §7: "The site is
 * static and free to read. get_index is a free MCP tool for the same reason — citation is the
 * business." No payment check ever runs for this tool (see ../paywall.ts).
 *
 * `date` and `version`: a print file is named `YYYY-MM-DD.json` and a print's own `version`
 * field is the basket version (e.g. "SIU-2026a"), not the filename — so `version` alone cannot
 * resolve a specific file without reading candidates and filtering. With no params, serves
 * `latest.json` (a byte-identical copy of the newest print — @touchstone/print's `writePrint`).
 *
 * Takes `printsDirPath` explicitly (mirroring @touchstone/print's `writePrint(printsDir, print)`)
 * rather than resolving it internally, so this is testable against a temp directory.
 */
export async function getIndexTool(input: GetIndexInput, printsDirPath: string): Promise<Print> {
  if (input.date) {
    return loadPrint(join(printsDirPath, `${input.date}.json`)).catch(() => {
      throw new Error(`No print for date "${input.date}".`);
    });
  }

  if (input.version) {
    const files = await readdir(printsDirPath).catch(() => [] as string[]);
    const candidates = files.filter(
      (f) => f !== "latest.json" && f !== "index.json" && f.endsWith(".json"),
    );
    const matches: Print[] = [];
    for (const file of candidates) {
      const print = await loadPrint(join(printsDirPath, file)).catch(() => undefined);
      if (print && print.version === input.version) {
        matches.push(print);
      }
    }
    if (matches.length === 0) {
      throw new Error(`No print for version "${input.version}".`);
    }
    matches.sort((a, b) => b.date.localeCompare(a.date));
    return matches[0];
  }

  return loadPrint(join(printsDirPath, "latest.json")).catch(() => {
    throw new Error(
      "No print has been published yet — data/prints/ has no latest.json. Publish one with " +
        "`pnpm --filter @touchstone/print run publish-print` first.",
    );
  });
}
