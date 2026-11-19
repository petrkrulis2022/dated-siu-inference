/**
 * Answers a single JSON-RPC call as plain JSON when the MCP transport replied with a Server-Sent
 * Events stream carrying exactly that one reply.
 *
 * Why: the MCP Streamable HTTP transport answers a tool call as `text/event-stream`, and a paying
 * client such as Circle's own `GatewayClient.pay()` (and x402 clients generally) reads the paid
 * response with `response.json()` — it paid, got the result, and then failed to parse it. The MCP
 * spec lets a server answer a POST with either content type and requires every client to accept
 * both, so a single reply as JSON is compliant, and a client that wants a stream still gets one
 * whenever it does not ask for JSON (the caller passes the request's Accept header). Anything that
 * is not exactly one complete message — more than one event, an unparseable payload, an error
 * status — is returned untouched, never rewritten.
 */
export async function singleReplyAsJson(
  response: Response,
  acceptHeader: string | null,
): Promise<Response> {
  const wantsJson = (acceptHeader ?? "").toLowerCase().includes("application/json");
  const isStream = (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");
  if (!wantsJson || !isStream || response.status !== 200) return response;

  const text = await response.clone().text();
  const messages = text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter((data) => data !== "");
  if (messages.length !== 1) return response;

  const only = messages[0] as string;
  try {
    JSON.parse(only);
  } catch {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(only, { status: 200, headers });
}
