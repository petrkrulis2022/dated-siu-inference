import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { printsDir } from "@touchstone/print";
import { runTool, type ToolDeps, type ToolName } from "./tools/run.js";
import { createToolPaywall, type PaywallOptions } from "./paywall.js";
import { TOOL_INPUT_SHAPES } from "./tools/schemas.js";
import { StubSettlementReader, type SettlementReader } from "./settlement/reader.js";
import { defaultDataSource, type PrintDataSource } from "./print-data-source.js";

export type { PrintDataSource } from "./print-data-source.js";

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function toolError(err: unknown) {
  return {
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

export interface McpServerOptions {
  settlementReader: SettlementReader;
  attestationPrivateKeyHex: string;
  printsDirPath?: string;
  dataSource?: PrintDataSource;
}

/** The four tools — build1-spec.md §9. Pricing is enforced entirely outside this function, by
 * ../paywall.ts dispatching in front of the transport; a tool handler here never checks payment
 * itself, it only does the work the caller already paid (or didn't need to pay) for. Each
 * handler is thin I/O glue over the pure, independently-tested functions in ./tools/. */
export function createTouchstoneMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({ name: "touchstone-assay", version: "1.0.0" });
  const printsDirPath = options.printsDirPath ?? printsDir();
  const dataSource = options.dataSource ?? defaultDataSource(printsDirPath);

  const toolDeps: ToolDeps = {
    dataSource,
    settlementReader: options.settlementReader,
    attestationPrivateKeyHex: options.attestationPrivateKeyHex,
  };
  const handler = (name: ToolName) => async (args: unknown) => {
    try {
      return toolResult(await runTool(name, args, toolDeps));
    } catch (err) {
      return toolError(err);
    }
  };

  server.registerTool(
    "get_index",
    {
      description: "The signed Dated SIU print. Free — citation is the business.",
      inputSchema: TOOL_INPUT_SHAPES.get_index,
    },
    handler("get_index"),
  );

  server.registerTool(
    "get_quote",
    {
      description: "SIU price, exchange rate and index refs for one task class and model.",
      inputSchema: TOOL_INPUT_SHAPES.get_quote,
    },
    handler("get_quote"),
  );

  server.registerTool(
    "convert",
    {
      description: "Convert a model call's token counts into SIU and USD.",
      inputSchema: TOOL_INPUT_SHAPES.convert,
    },
    handler("convert"),
  );

  server.registerTool(
    "verify_receipt",
    {
      description: "Reads an on-chain settlement and returns a signed attestation.",
      inputSchema: TOOL_INPUT_SHAPES.verify_receipt,
    },
    handler("verify_receipt"),
  );

  return server;
}

export interface BuildAppOptions {
  attestationPrivateKeyHex: string;
  settlementReader?: SettlementReader;
  paywall?: PaywallOptions;
  printsDirPath?: string;
  /** Test-only escape hatch — never set in production. Lets paywall.test.ts and
   * server.test.ts exercise tool logic without a real Circle-configured seller address. */
  skipPaywall?: boolean;
}

const NO_PAYWALL = (_req: Request, _res: Response, next: NextFunction): void => next();

/**
 * Builds the Express app: one `POST /mcp` route carrying a Streamable HTTP MCP transport in
 * stateless mode (`sessionIdGenerator: undefined` — no session tracking, matching the SDK's own
 * documented stateless-server pattern), with the paywall dispatch running first so a `402` for a
 * paid tool never reaches the MCP layer at all.
 *
 * A fresh `StreamableHTTPServerTransport` is created and connected per request, rather than one
 * shared instance reused across requests. The SDK's own doc comment shows a single shared
 * `transport` in its usage snippet, but reusing one instance across separate requests corrupts
 * its internal per-connection state in the installed SDK version (@modelcontextprotocol/sdk
 * 1.30.0) — verified directly: a shared transport answers the first request fine and then
 * fails every subsequent one with a bare 500 and no thrown error to catch. The `McpServer`
 * itself (tool registrations) is built once and safely reused; only the transport is
 * per-request.
 */
export function buildApp(options: BuildAppOptions): Express {
  const app = express();
  app.use(express.json());

  const paywall = options.skipPaywall ? NO_PAYWALL : createToolPaywall(options.paywall);
  const mcpServer = createTouchstoneMcpServer({
    settlementReader: options.settlementReader ?? new StubSettlementReader(),
    attestationPrivateKeyHex: options.attestationPrivateKeyHex,
    printsDirPath: options.printsDirPath,
  });

  app.post("/mcp", paywall, async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
    });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // Otherwise an internal transport error surfaces as a bare 500 with nothing in the
      // response body and nothing logged — impossible to debug from the outside.
      console.error("MCP transport error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  return app;
}
