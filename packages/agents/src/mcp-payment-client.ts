import { GatewayClient, type BatchEvmScheme } from "@circle-fin/x402-batching/client";

/**
 * A real x402 client for Touchstone Assay's paid MCP tools — the same 402 -> sign -> retry flow
 * `GatewayClient.pay()` implements, reimplemented here only because this MCP endpoint's
 * `tools/call` response is Streamable-HTTP SSE-framed ("event: message\ndata: {...}"), which
 * `pay()`'s own `.json()` response parsing cannot read. The payment itself — the real EIP-712
 * signature, the real settlement `GatewayClient.batchScheme` produces — is identical; only how
 * the final response body is read differs. Found live during MCP distribution verification
 * (2026-08-31), productionised here instead of staying a throwaway script.
 */

export interface McpToolCallResult {
  status: number;
  text: string;
  /** JSON-RPC id echoed by the server; useful for correlating a specific call in logs. */
  jsonrpcId: number;
}

export interface PaidMcpToolCallResult extends McpToolCallResult {
  /** Empty when the call was free (no PAYMENT-RESPONSE header) or the settlement info couldn't
   * be decoded — never assumed present. */
  transaction: string;
  amountUsdcMinorUnits: string;
}

/** Opens one MCP session against `mcpUrl` via the real `initialize` handshake — every subsequent
 * `tools/call` in that session must carry the returned session id. */
export async function initMcpSession(mcpUrl: string, clientName: string): Promise<string> {
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
        clientInfo: { name: clientName, version: "1.0" },
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id");
  await res.text(); // drain the body — initialize's own SSE payload isn't needed here.
  if (!sessionId) {
    throw new Error(`${mcpUrl} did not return an Mcp-Session-Id from initialize.`);
  }
  return sessionId;
}

/** Calls a free tool (`get_index`) — a plain POST, no payment. */
export async function callFreeMcpTool(
  mcpUrl: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  jsonrpcId = 2,
): Promise<McpToolCallResult> {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: jsonrpcId,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  return { status: res.status, text: await res.text(), jsonrpcId };
}

/** Calls a paid tool for real, through Circle's Gateway — the full 402 challenge, a real signed
 * EIP-712 authorization, a real settlement. `gateway` must already hold enough Gateway balance
 * (see docs/README.md's "Setup, once" for provisioning one). */
export async function callPaidMcpTool(
  gateway: GatewayClient,
  mcpUrl: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  jsonrpcId = 2,
): Promise<PaidMcpToolCallResult> {
  const headers = { accept: "application/json, text/event-stream", "mcp-session-id": sessionId };
  const body = {
    jsonrpc: "2.0",
    id: jsonrpcId,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  };

  const initialResponse = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (initialResponse.status !== 402) {
    // Not priced today (e.g. the pre-check already determined the call would fail and forwarded
    // it unpaid) — return whatever came back rather than assume every call is paid.
    return {
      status: initialResponse.status,
      text: await initialResponse.text(),
      jsonrpcId,
      transaction: "",
      amountUsdcMinorUnits: "0",
    };
  }

  const paymentRequiredHeader = initialResponse.headers.get("PAYMENT-REQUIRED");
  if (!paymentRequiredHeader) {
    throw new Error(`${toolName}: 402 with no PAYMENT-REQUIRED header.`);
  }
  const paymentRequired = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf-8"));
  const expectedNetwork = `eip155:${gateway.chainConfig.chain.id}`;
  const batchingOption = paymentRequired.accepts?.find(
    (opt: { network: string; extra?: Record<string, unknown> }) =>
      opt.network === expectedNetwork &&
      opt.extra?.name === "GatewayWalletBatched" &&
      opt.extra?.version === "1" &&
      typeof opt.extra?.verifyingContract === "string",
  );
  if (!batchingOption) {
    throw new Error(`${toolName}: no Gateway batching option for ${expectedNetwork}.`);
  }

  const x402Version = paymentRequired.x402Version ?? 2;
  const amount = String(batchingOption.amount);
  // batchScheme is TS-private on GatewayClient (compile-time only — real at runtime), the same
  // field its own pay() reads internally (see this file's doc comment above). Cast through
  // unknown rather than any, since BatchEvmScheme is a real exported type to cast to.
  const batchScheme = (gateway as unknown as { batchScheme: BatchEvmScheme }).batchScheme;
  const paymentPayload = await batchScheme.createPaymentPayload(x402Version, batchingOption);
  const paymentHeader = Buffer.from(
    JSON.stringify({ ...paymentPayload, resource: paymentRequired.resource, accepted: batchingOption }),
  ).toString("base64");

  const paidResponse = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers, "Payment-Signature": paymentHeader },
    body: JSON.stringify(body),
  });
  const paymentResponseHeader = paidResponse.headers.get("PAYMENT-RESPONSE");
  let transaction = "";
  if (paymentResponseHeader) {
    const settleResponse = JSON.parse(Buffer.from(paymentResponseHeader, "base64").toString("utf-8"));
    transaction = settleResponse?.transaction ?? "";
  }

  return {
    status: paidResponse.status,
    text: await paidResponse.text(),
    jsonrpcId,
    transaction,
    amountUsdcMinorUnits: amount,
  };
}

/** Pulls the JSON-RPC result's text content out of an SSE-framed ("event: message\ndata: {...}")
 * or plain-JSON tools/call response — the two shapes this MCP transport can return. */
export function parseMcpToolText(sseOrJsonBody: string): { isError: boolean; text: string } {
  const dataLine = sseOrJsonBody
    .split("\n")
    .find((line) => line.startsWith("data: "));
  const jsonText = dataLine ? dataLine.slice("data: ".length) : sseOrJsonBody;
  const parsed = JSON.parse(jsonText);
  const content = parsed.result?.content as { type: string; text?: string }[] | undefined;
  const textBlock = content?.find((c) => c.type === "text" && typeof c.text === "string");
  return { isError: Boolean(parsed.result?.isError), text: textBlock?.text ?? "" };
}
