/**
 * Raw fetch against Claude's Messages API, matching this repo's own established pattern
 * (packages/harness/src/adapters/anthropic.ts) rather than adding an SDK dependency: this
 * codebase has never depended on a provider SDK anywhere, always direct fetch, to stay minimal
 * and Workers-compatible. Adds tool use, which the harness adapter doesn't need.
 */

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AnthropicHttpError";
  }
}

export async function callClaude(
  apiKey: string,
  model: string,
  system: string,
  messages: AnthropicMessage[],
  tools: ToolDefinition[],
  maxTokens = 1024,
): Promise<AnthropicResponse> {
  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, system, messages, tools, max_tokens: maxTokens }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new AnthropicHttpError(`Claude request failed: ${res.status} ${bodyText}`, res.status);
  }
  return (await res.json()) as AnthropicResponse;
}

/** The text Claude actually said, ignoring tool_use blocks — what a chat UI shows the visitor. */
export function extractText(response: AnthropicResponse): string {
  return response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function extractToolUses(
  response: AnthropicResponse,
): { id: string; name: string; input: Record<string, unknown> }[] {
  return response.content.filter(
    (block): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
      block.type === "tool_use",
  );
}
