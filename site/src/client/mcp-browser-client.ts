/**
 * A minimal MCP client for calling the free `get_index` tool live, from the browser — the one
 * tool this page ever calls. Ported from packages/chat-server/src/mcp-client.ts (same shape,
 * same plain-fetch approach — that file already had no Node-specific APIs, only the Worker's own
 * CORS exemption to lose by moving here, which packages/mcp-server/src/workers/index.ts now
 * grants explicitly to this site's own origin). No payment/x402 handling exists here because
 * get_index never needs to pay for anything, and the three paid tools are never called from this
 * file at all — see try-it-here.ts's own doc comment for that guardrail.
 */

const MCP_SERVER_URL = "https://mcp.touchstoneassay.com/mcp";

async function initMcpSession(): Promise<string> {
  const res = await fetch(MCP_SERVER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "touchstone-try-it-here", version: "1.0" },
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id");
  await res.text();
  if (!sessionId) throw new Error("The MCP server did not return a session id from initialize.");
  return sessionId;
}

/** Pulls the JSON-RPC result's text content out of an SSE-framed ("event: message\ndata: {...}")
 * or plain-JSON tools/call response — the same shape every other MCP client in this repo parses. */
function parseToolText(sseOrJsonBody: string): { isError: boolean; text: string } {
  const dataLine = sseOrJsonBody.split("\n").find((line) => line.startsWith("data: "));
  const jsonText = dataLine ? dataLine.slice("data: ".length) : sseOrJsonBody;
  const parsed = JSON.parse(jsonText);
  const content = parsed.result?.content as { type: string; text?: string }[] | undefined;
  const textBlock = content?.find((c) => c.type === "text" && typeof c.text === "string");
  return { isError: Boolean(parsed.result?.isError), text: textBlock?.text ?? "" };
}

async function callGetIndex(): Promise<unknown> {
  const sessionId = await initMcpSession();
  const res = await fetch(MCP_SERVER_URL, {
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

let inFlight: Promise<unknown> | undefined;

/** Calls the free `get_index` tool for real, live, against the deployed MCP server — memoized so
 * a page rendering two tools from the same print (get_current_print, compare_model_cost) shares
 * one network round trip rather than fetching twice. Throws on any error; the caller must show an
 * explicit failure state, never a stale or guessed value — the memo itself is cleared on failure
 * so a later retry genuinely re-fetches rather than replaying a rejected promise forever. */
export function fetchLatestPrint(): Promise<unknown> {
  if (!inFlight) {
    inFlight = callGetIndex().catch((err: unknown) => {
      inFlight = undefined;
      throw err;
    });
  }
  return inFlight;
}
