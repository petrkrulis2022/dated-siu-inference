import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Receipt } from "@touchstone/sdk";
import type { VerifyReceiptInput } from "@touchstone/mcp-server";

/**
 * The buyer calls `verify_receipt` as a genuine MCP tool call over the real Streamable HTTP
 * transport — the same client shape any real MCP-speaking agent would use — rather than
 * importing `verifyReceiptTool` and calling it in-process. In-process would require the buyer to
 * hold `TOUCHSTONE_PUBLISHER_KEY`, breaking the entire point of the tool: Touchstone Assay, not the buyer,
 * attests. See docs/demo.md for why this demo's server instance bypasses Circle's paywall.
 */
export async function callVerifyReceipt(
  serverUrl: string,
  input: VerifyReceiptInput,
): Promise<Receipt> {
  const client = new Client({ name: "touchstone-demo-buyer", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "verify_receipt",
      arguments: { ...input },
    });
    if (result.isError) {
      const text = Array.isArray(result.content)
        ? result.content.map((c) => ("text" in c ? c.text : "")).join(" ")
        : String(result.content);
      throw new Error(`verify_receipt returned an error: ${text}`);
    }
    const content = result.content as { type: string; text?: string }[];
    const textBlock = content.find((c) => c.type === "text" && typeof c.text === "string");
    if (!textBlock?.text) {
      throw new Error("verify_receipt returned no text content.");
    }
    return JSON.parse(textBlock.text) as Receipt;
  } finally {
    await client.close();
  }
}
