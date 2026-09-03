/**
 * A minimal MCP client for calling `get_index` on the live, deployed MCP server — the one tool
 * this backend ever actually executes. `get_quote`/`convert` are never called here at all (see
 * workers/index.ts's tool-execution guardrail); no payment/x402 handling exists in this file
 * because it never needs to pay for anything. Deliberately not a dependency on
 * `packages/agents/src/mcp-payment-client.ts` — that file exists for a CLI script with viem/
 * Circle Gateway payment signing this Worker has no reason to pull in for a single free call.
 */

async function initMcpSession(mcpUrl: string): Promise<string> {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "touchstone-chat", version: "1.0" },
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id");
  await res.text();
  if (!sessionId) throw new Error(`${mcpUrl} did not return an Mcp-Session-Id from initialize.`);
  return sessionId;
}

/** Pulls the JSON-RPC result's text content out of an SSE-framed ("event: message\ndata: {...}")
 * or plain-JSON tools/call response — the same shape mcp-payment-client.ts's parser handles. */
function parseToolText(sseOrJsonBody: string): { isError: boolean; text: string } {
  const dataLine = sseOrJsonBody.split("\n").find((line) => line.startsWith("data: "));
  const jsonText = dataLine ? dataLine.slice("data: ".length) : sseOrJsonBody;
  const parsed = JSON.parse(jsonText);
  const content = parsed.result?.content as { type: string; text?: string }[] | undefined;
  const textBlock = content?.find((c) => c.type === "text" && typeof c.text === "string");
  return { isError: Boolean(parsed.result?.isError), text: textBlock?.text ?? "" };
}

/** Calls the free `get_index` tool for real against the live MCP server and returns the parsed
 * print JSON. Throws on any error — a chat reply about the index must never fall back to a
 * guessed or stale value; if this fails, the caller should tell the visitor the lookup failed,
 * not answer from the model's own memory. */
export async function fetchLiveIndex(mcpUrl: string): Promise<unknown> {
  const sessionId = await initMcpSession(mcpUrl);
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_index", arguments: {} },
    }),
  });
  const { isError, text } = parseToolText(await res.text());
  if (isError) throw new Error(`get_index failed: ${text}`);
  return JSON.parse(text);
}
