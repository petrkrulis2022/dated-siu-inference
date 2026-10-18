/**
 * GPT's side of the tool loop: the Chat Completions request and response shapes (tools as `function` entries, assistant turns carrying `tool_calls`, tool results as `tool` messages), a client that
 * retries a 429 or a server error a couple of times, and the `ToolChat` the generic loop (`tool-loop.ts`) drives. Written to OpenAI's documented shapes and exercised on the fake server with a
 * scripted API; the first live smoke test must confirm it, as the Claude loop's first live run confirmed its own.
 *
 * Usage: OpenAI documents `completion_tokens` as already containing reasoning tokens, so a turn is priced on output alone, as for Claude (unconfirmed until that first live call). `prompt_tokens`
 * contains the cached tokens, which are billed at the cached rate, so they are taken out of the plain input and priced on their own.
 */
import type { Secret } from "../keys.js";
import type { ChatReply, ChatTurn, ToolChat } from "./tool-loop.js";
import type { McpToolDef } from "./types.js";

interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
interface AssistantMessage {
  role?: string;
  content?: string | null;
  tool_calls?: ToolCall[];
}
interface ChatResponse {
  choices?: { message?: AssistantMessage; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** One request to the Chat Completions API. `attempts` is how many tries it took. */
export interface ChatCompletionsApi {
  send(body: Record<string, unknown>): Promise<{ status: number; json: unknown; attempts: number }>;
}

const RETRYABLE = new Set([429, 500, 502, 503]);

export function openAiChatApi(
  apiKey: Secret,
  opts: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    delaysMs?: number[];
  } = {},
): ChatCompletionsApi {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = opts.delaysMs ?? [2_000, 6_000];
  return {
    async send(body) {
      for (let attempt = 1; ; attempt++) {
        const res = await doFetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey.reveal()}`,
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

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(raw ?? "{}") as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

type Message = Record<string, unknown>;

/** The `ToolChat` for GPT over a `ChatCompletionsApi`. */
export function openAiChat(api: ChatCompletionsApi, modelString: string): ToolChat {
  return {
    provider: "openai",
    init: (prompt) => [{ role: "user", content: prompt } satisfies Message],
    toolSpecs: (tools: McpToolDef[]) =>
      tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    async send(messages, tools, maxTokens): Promise<ChatTurn> {
      const r = await api.send({
        model: modelString,
        max_completion_tokens: maxTokens,
        messages,
        tools,
      });
      if (r.status !== 200) return { status: r.status, attempts: r.attempts };
      const resp = (r.json ?? {}) as ChatResponse;
      const choice = resp.choices?.[0];
      const msg = choice?.message ?? {};
      const calls = (msg.tool_calls ?? []).filter(
        (c) => c.type === undefined || c.type === "function",
      );
      const prompt = resp.usage?.prompt_tokens ?? 0;
      const cached = resp.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const reply: ChatReply = {
        text: (msg.content ?? "").trim(),
        toolUses: calls.map((c) => ({
          id: String(c.id ?? ""),
          name: String(c.function?.name ?? ""),
          args: parseArgs(c.function?.arguments),
        })),
        wantsTools: choice?.finish_reason === "tool_calls" && calls.length > 0,
        ...(choice?.finish_reason !== undefined ? { stopReason: choice.finish_reason } : {}),
        usage: {
          input: Math.max(0, prompt - cached),
          output: resp.usage?.completion_tokens ?? 0,
          cachedInput: cached,
        },
        // only the fields the API accepts back: the role, the text and the calls
        assistant: {
          role: "assistant",
          content: msg.content ?? null,
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        },
      };
      return { status: 200, attempts: r.attempts, reply };
    },
    appendAssistant: (messages, assistant) => (messages as Message[]).push(assistant as Message),
    appendToolResults: (messages, results) => {
      for (const x of results)
        (messages as Message[]).push({
          role: "tool",
          tool_call_id: x.id,
          content: x.isError ? `Error: ${x.text}` : x.text,
        });
    },
  };
}
