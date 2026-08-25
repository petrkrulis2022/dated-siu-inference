import type { Print } from "@touchstone/sdk";
import type { PrintDataSource } from "../print-data-source.js";

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
 * A pure function over `dataSource` (../print-data-source.js) rather than a filesystem path —
 * the Node CLI and the Cloudflare Workers deployment both call this unchanged, supplying
 * different `PrintDataSource` implementations.
 */
export type GetIndexOutput = Print & {
  /** Present only on the no-params (latest) path — the one case with a cache in front of it.
   * Honest hit/miss reporting, never silently one or the other. */
  _meta?: { cached: boolean; fetched_at: string };
};

export async function getIndexTool(
  input: GetIndexInput,
  dataSource: PrintDataSource,
): Promise<GetIndexOutput> {
  if (input.date) {
    return dataSource.loadPrintByDate(input.date).catch(() => {
      throw new Error(`No print for date "${input.date}".`);
    });
  }

  if (input.version) {
    const ids = await dataSource.listPrintIds();
    const matches: Print[] = [];
    for (const id of ids) {
      const print = await dataSource.loadPrintByDate(id).catch(() => undefined);
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

  const { print, cached, fetchedAt } = await dataSource.loadLatestPrint();
  return { ...print, _meta: { cached, fetched_at: fetchedAt } };
}
