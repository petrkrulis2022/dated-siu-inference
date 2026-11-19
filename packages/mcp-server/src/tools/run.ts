import type { RunRecord } from "@touchstone/sdk";
import type { PrintDataSource } from "../print-data-source.js";
import type { SettlementReader } from "../settlement/reader.js";
import { getIndexTool, type GetIndexInput } from "./get-index.js";
import { getQuoteTool, type GetQuoteInput } from "./get-quote.js";
import { convertTool, type ConvertInput } from "./convert.js";
import { verifyReceiptTool, type VerifyReceiptInput } from "./verify-receipt.js";

export type ToolName = "get_index" | "get_quote" | "convert" | "verify_receipt";

export interface ToolDeps {
  dataSource: PrintDataSource;
  settlementReader: SettlementReader;
  attestationPrivateKeyHex: string;
}

/**
 * Runs one tool exactly as the MCP server registers it — the single copy of each tool's I/O glue,
 * read by both transports (../server.ts's MCP handlers and ../workers/rest.ts's HTTP routes), so a
 * quote fetched over REST can never differ from the same quote fetched over MCP. Arguments are
 * trusted to have passed ./schemas.ts already; a failure is a thrown Error carrying a caller-facing
 * message, which each transport reports in its own way.
 */
export async function runTool(name: ToolName, args: unknown, deps: ToolDeps): Promise<unknown> {
  switch (name) {
    case "get_index":
      return getIndexTool(args as GetIndexInput, deps.dataSource);
    case "get_quote": {
      const input = args as GetQuoteInput;
      const { print } = await deps.dataSource.loadLatestPrint();
      const snapshot = await deps.dataSource.loadPriceSnapshot(print.price_snapshot_ref);
      const allRecords: RunRecord[] = await deps.dataSource.loadRunRecords(print.print_id);
      const modelRecords = allRecords.filter((r) => r.model_id === input.model);
      return getQuoteTool(input, print, snapshot, modelRecords);
    }
    case "convert": {
      const { print } = await deps.dataSource.loadLatestPrint();
      const snapshot = await deps.dataSource.loadPriceSnapshot(print.price_snapshot_ref);
      return convertTool(args as ConvertInput, print, snapshot);
    }
    case "verify_receipt":
      return verifyReceiptTool(
        args as VerifyReceiptInput,
        deps.settlementReader,
        deps.attestationPrivateKeyHex,
      );
  }
}
