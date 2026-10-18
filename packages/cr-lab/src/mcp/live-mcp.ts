/**
 * The live Blockworks MCP as an `McpBackend` (D91): the SDK's client over streamable HTTP with the stored OAuth tokens, every call paced by the rate governor (the same one that paces the
 * snapshot, so the trial's live load obeys one set of limits, with its own group). The server's whole tool list is returned by `tools()`; the loop offers a model only the four data tools and
 * records the rest as withheld. A tool result is relayed as the text the server sent; a server that answers with something else (an image, a resource) is told to the model as omitted.
 * If the stored login no longer works, `McpLoginRequired` is thrown and nothing is retried: the owner signs in again with `mcp-login`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RateGovernor } from "../data-desk/governor.js";
import type { McpBackend, McpCallResult, McpToolDef } from "./types.js";

export const BLOCKWORKS_MCP_URL = "https://mcp.blockworks.com/mcp";
export const MCP_GOVERNOR_GROUP = "mcp";

export class McpLoginRequired extends Error {
  constructor() {
    super("the stored Blockworks MCP login no longer works: sign in again with mcp-login");
    this.name = "McpLoginRequired";
  }
}

const statusOf = (e: unknown): number | undefined => {
  const c = (e as { code?: unknown }).code;
  return typeof c === "number" && c >= 100 && c < 600 ? c : undefined;
};

export class LiveMcp implements McpBackend {
  readonly name = "live" as const;
  readonly #client: Client;
  readonly #governor: RateGovernor | undefined;

  private constructor(client: Client, governor: RateGovernor | undefined) {
    this.#client = client;
    this.#governor = governor;
  }

  /** Connects with a transport: the real one over HTTP with the stored login, or one given (tests). */
  static async connect(opts: {
    url?: string;
    provider?: OAuthClientProvider;
    transport?: Transport;
    governor?: RateGovernor;
  }): Promise<LiveMcp> {
    const client = new Client(
      { name: "touchstone-cr-trial", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport =
      opts.transport ??
      new StreamableHTTPClientTransport(new URL(opts.url ?? BLOCKWORKS_MCP_URL), {
        ...(opts.provider !== undefined ? { authProvider: opts.provider } : {}),
      });
    try {
      await client.connect(transport);
    } catch (e) {
      if (e instanceof UnauthorizedError) throw new McpLoginRequired();
      throw e;
    }
    return new LiveMcp(client, opts.governor);
  }

  async tools(): Promise<McpToolDef[]> {
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#client.listTools(cursor === undefined ? {} : { cursor });
      for (const t of page.tools)
        out.push({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema as Record<string, unknown>,
        });
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const once = async (): Promise<{ status: number; value: McpCallResult }> => {
      try {
        const res = await this.#client.callTool({ name, arguments: args });
        const parts = Array.isArray(res.content)
          ? (res.content as { type: string; text?: string }[])
          : [];
        const text = parts
          .map((p) =>
            p.type === "text" && typeof p.text === "string"
              ? p.text
              : `[${p.type} content omitted]`,
          )
          .join("\n");
        const body =
          text === "" && res.structuredContent !== undefined
            ? JSON.stringify(res.structuredContent)
            : text;
        return { status: 200, value: { isError: res.isError === true, text: body } };
      } catch (e) {
        if (e instanceof UnauthorizedError) throw new McpLoginRequired();
        const status = statusOf(e);
        // an HTTP status the governor should back off on is passed to it; anything else is the server's refusal, relayed as an error result
        return {
          status: status ?? 200,
          value: {
            isError: true,
            text: e instanceof Error ? e.message.slice(0, 300) : "tool call failed",
          },
        };
      }
    };
    return this.#governor !== undefined
      ? this.#governor.run(MCP_GOVERNOR_GROUP, once)
      : (await once()).value;
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}
