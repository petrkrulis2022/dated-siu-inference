import { describe, expect, it } from "vitest";
import { parseMcpToolText } from "./mcp-payment-client.js";

describe("parseMcpToolText", () => {
  it("extracts the tool result's text content from an SSE-framed tools/call response", () => {
    const sse =
      'event: message\nid: abc:0000000000000001\ndata: {"result":{"content":[{"type":"text","text":"{\\"siu_per_call\\":\\"0.02\\"}"}]},"jsonrpc":"2.0","id":2}\n\n';
    const { isError, text } = parseMcpToolText(sse);
    expect(isError).toBe(false);
    expect(text).toBe('{"siu_per_call":"0.02"}');
  });

  it("extracts from a plain-JSON (non-SSE) response the same way", () => {
    const json = '{"result":{"content":[{"type":"text","text":"hello"}]},"jsonrpc":"2.0","id":2}';
    const { isError, text } = parseMcpToolText(json);
    expect(isError).toBe(false);
    expect(text).toBe("hello");
  });

  it("reports isError: true for a tool error result", () => {
    const sse =
      'event: message\ndata: {"result":{"content":[{"type":"text","text":"boom"}],"isError":true},"jsonrpc":"2.0","id":2}\n\n';
    const { isError, text } = parseMcpToolText(sse);
    expect(isError).toBe(true);
    expect(text).toBe("boom");
  });
});
