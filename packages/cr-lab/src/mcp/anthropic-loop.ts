/**
 * Claude's side of the tool loop: the Messages API request and response shapes (tools with an `input_schema`, assistant turns of content blocks including thinking, tool results as user-turn
 * blocks), a client that retries a 429 or a server error a couple of times, and the `ToolChat` the generic loop (`tool-loop.ts`) drives. `output_tokens` already includes thinking tokens
 * (verified on the first live dry run, 2026-10-17), so a turn is priced on output alone.
 */
import type { Secret } from "../keys.js";
import type { ChatReply, ChatTurn, ToolChat } from "./tool-loop.js";
import type { McpToolDef } from "./types.js";

export * from "./tool-loop.js";

type Block = { type: string; [k: string]: unknown };
interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
interface ApiResponse {
  content?: Block[];
  stop_reason?: string;
  usage?: ApiUsage;
}

/** One request to the Messages API. `attempts` is how many tries it took. */
export interface MessagesApi {
  send(body: Record<string, unknown>): Promise<{ status: number; json: unknown; attempts: number }>;
}

const RETRYABLE = new Set([429, 500, 502, 503, 529]);

export function anthropicMessagesApi(
  apiKey: Secret,
  opts: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    delaysMs?: number[];
  } = {},
): MessagesApi {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = opts.delaysMs ?? [2_000, 6_000];
  return {
    async send(body) {
      for (let attempt = 1; ; attempt++) {
        const res = await doFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey.reveal(),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
        });
        let json: unknown = null;
        try {
          json = await res.json();
        } catch {
          json = null;
        }
        const wait = delays[attempt - 1];
        if (RETRYABLE.has(res.status) && wait !== undefined) {
          await sleep(wait);
          continue;
        }
        return { status: res.status, json, attempts: attempt };
      }
    },
  };
}

const textOf = (blocks: Block[]): string =>
  blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();

/** The `ToolChat` for Claude over a `MessagesApi`. */
export function anthropicChat(api: MessagesApi, modelString: string): ToolChat {
  type Message = { role: "user" | "assistant"; content: string | Block[] };
  return {
    provider: "anthropic",
    init: (prompt) => [{ role: "user", content: prompt } satisfies Message],
    toolSpecs: (tools: McpToolDef[]) =>
      tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    async send(messages, tools, maxTokens): Promise<ChatTurn> {
      const r = await api.send({ model: modelString, max_tokens: maxTokens, messages, tools });
      if (r.status !== 200) return { status: r.status, attempts: r.attempts };
      const resp = (r.json ?? {}) as ApiResponse;
      const content = resp.content ?? [];
      const usage = resp.usage ?? {};
      const uses = content.filter((b) => b.type === "tool_use");
      const reply: ChatReply = {
        text: textOf(content),
        toolUses: uses.map((u) => ({
          id: String(u.id ?? ""),
          name: String(u.name ?? ""),
          args: (typeof u.input === "object" && u.input !== null ? u.input : {}) as Record<
            string,
            unknown
          >,
        })),
        wantsTools: resp.stop_reason === "tool_use",
        ...(resp.stop_reason !== undefined ? { stopReason: resp.stop_reason } : {}),
        usage: {
          input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          output: usage.output_tokens ?? 0,
          cachedInput: usage.cache_read_input_tokens ?? 0,
        },
        assistant: content,
      };
      return { status: 200, attempts: r.attempts, reply };
    },
    appendAssistant: (messages, assistant) =>
      (messages as Message[]).push({ role: "assistant", content: assistant as Block[] }),
    appendToolResults: (messages, results) =>
      (messages as Message[]).push({
        role: "user",
        content: results.map((x) => ({
          type: "tool_result",
          tool_use_id: x.id,
          content: x.text,
          ...(x.isError ? { is_error: true } : {}),
        })),
      }),
  };
}
