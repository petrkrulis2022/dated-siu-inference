/**
 * What MCP mode needs from a Blockworks MCP server, whether it is the fake over the fixtures or (later) the live one signed in by the owner (D91). The harness holds the connection and
 * the credentials; a model only ever sees `tools()` and the text `call` returns, so no key can reach it. Only the four data tools are given to a model: `search_documents` returns article
 * text (large, narrative, not what the four tasks are answered from) and is withheld (D99), which each session's record states.
 */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  /** the server refused or failed the call; `text` then says why, as a server's error text does */
  isError: boolean;
  /** exactly what the model is shown */
  text: string;
}

export interface McpBackend {
  readonly name: "fake" | "live";
  /** the tools offered to a model */
  tools(): Promise<McpToolDef[]>;
  call(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/** The tools a model is offered, by name. Anything else a server lists is withheld. */
export const MCP_DATA_TOOLS: readonly string[] = [
  "tabular_catalog",
  "tabular_data",
  "timeseries_catalog",
  "timeseries_data",
];

/** Tools the harness holds back from models, and says so in each session's record. */
export const MCP_WITHHELD_TOOLS: readonly string[] = ["search_documents"];
