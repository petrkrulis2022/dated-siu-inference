/**
 * Claude's side of the tool loop: the Messages API request and response shapes (tools with an `input_schema`, assistant turns of content blocks including thinking, tool results as user-turn
 * blocks), a client that retries a 429 or a server error a couple of times, and the `ToolChat` the generic loop (`tool-loop.ts`) drives. `output_tokens` already includes thinking tokens
 * (verified on the first live dry run, 2026-10-17), so a turn is priced on output alone.
 */
import type { Secret } from "../keys.js";
import { reasoningOfBlocks, requestsThinkingSummary } from "../runner/reasoning.js";
import type { ChatReply, ChatTurn, ToolChat } from "./tool-loop.js";
import type { McpToolDef } from "./types.js";

export * from "./tool-loop.js";

type Block = { type: string; [k: string]: unknown };
interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** reported by the API when thinking happened; already inside `output_tokens` */
  output_tokens_details?: { thinking_tokens?: number };
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

/** The status a retry should see for an error the API reports inside an event stream, after a 200 had already been sent. */
const STREAM_ERROR_STATUS: Record<string, number> = {
  overloaded_error: 529,
  api_error: 500,
  rate_limit_error: 429,
};

interface StreamEvent {
  type?: string;
  index?: number;
  message?: { usage?: Record<string, unknown> };
  content_block?: Block;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: Record<string, unknown>;
  error?: { type?: string };
}

/**
 * Reads the Messages API's event stream into the message a non-streaming call returns: the same `content` blocks (a thinking block keeps its `signature`, which has to go back with the
 * turn), `stop_reason` and `usage` (input side from `message_start`, output side from the last `message_delta`). A request that takes minutes to generate (a 40,000-token allowance) cannot be
 * sent non-streaming: Node's fetch gives up after 300 s without response headers, which is how every attempt at CR-VS on 2026-10-24 ended in a `TypeError` (D123). A stream that ends before
 * `message_stop` is thrown as a `TypeError`, the class the loop already treats as no answer having reached us.
 */
export async function readMessageStream(
  body: ReadableStream<Uint8Array>,
): Promise<{ status: number; json: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const blocks: Block[] = [];
  const partialJson = new Map<number, string>();
  const usage: Record<string, unknown> = {};
  let stopReason: string | undefined;
  let stopped = false;
  let failed: { status: number; json: unknown } | undefined;

  const handle = (raw: string): void => {
    const data = raw
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (data === "") return;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(data) as StreamEvent;
    } catch {
      throw new TypeError("an unreadable event in the response stream");
    }
    const i = ev.index ?? -1;
    switch (ev.type) {
      case "message_start":
        Object.assign(usage, ev.message?.usage);
        break;
      case "content_block_start":
        if (ev.content_block !== undefined) blocks[i] = { ...ev.content_block };
        break;
      case "content_block_delta": {
        const b = blocks[i];
        const d = ev.delta;
        if (b === undefined || d === undefined) break;
        if (d.type === "text_delta") b.text = String(b.text ?? "") + (d.text ?? "");
        else if (d.type === "thinking_delta")
          b.thinking = String(b.thinking ?? "") + (d.thinking ?? "");
        else if (d.type === "signature_delta") b.signature = d.signature ?? "";
        else if (d.type === "input_json_delta")
          partialJson.set(i, (partialJson.get(i) ?? "") + (d.partial_json ?? ""));
        break;
      }
      case "content_block_stop": {
        const b = blocks[i];
        const json = partialJson.get(i);
        if (b !== undefined && b.type === "tool_use" && json !== undefined && json !== "") {
          try {
            b.input = JSON.parse(json);
          } catch {
            b.input = {};
          }
        }
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason !== undefined) stopReason = ev.delta.stop_reason;
        for (const [k, v] of Object.entries(ev.usage ?? {}))
          if (v !== null && v !== undefined) usage[k] = v;
        break;
      case "message_stop":
        stopped = true;
        break;
      case "error":
        failed = {
          status: STREAM_ERROR_STATUS[ev.error?.type ?? ""] ?? 500,
          json: { error: { type: ev.error?.type ?? "unknown" } },
        };
        break;
      default:
        break; // ping, and event types this client does not use
    }
  };

  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    for (;;) {
      const gap = /\r?\n\r?\n/.exec(buffered);
      if (gap === null) break;
      const event = buffered.slice(0, gap.index);
      buffered = buffered.slice(gap.index + gap[0].length);
      handle(event);
      if (failed !== undefined) return failed;
    }
  }
  buffered += decoder.decode();
  if (buffered.trim() !== "") handle(buffered);
  if (failed !== undefined) return failed;
  if (!stopped) throw new TypeError("the response stream ended before message_stop");
  return {
    status: 200,
    json: {
      content: blocks.filter((b) => b !== undefined),
      ...(stopReason !== undefined ? { stop_reason: stopReason } : {}),
      usage,
    },
  };
}

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
          body: JSON.stringify({ ...body, stream: true }),
          redirect: "error",
        });
        let status = res.status;
        let json: unknown;
        if (
          res.ok &&
          res.body !== null &&
          (res.headers.get("content-type") ?? "").includes("text/event-stream")
        ) {
          ({ status, json } = await readMessageStream(res.body));
        } else {
          try {
            json = await res.json();
          } catch {
            json = null;
          }
        }
        const wait = delays[attempt - 1];
        if (RETRYABLE.has(status) && wait !== undefined) {
          await sleep(wait);
          continue;
        }
        return { status, json, attempts: attempt };
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

/**
 * The `ToolChat` for Claude over a `MessagesApi`. For a model whose thinking text is hidden by default (Sonnet), every request asks for its summary, `thinking: {type: "adaptive", display:
 * "summarized"}`, the one setting touched (D107, D59): it asks for a summary of thinking already happening. `summary: false` turns it off, for the tests that compare the two.
 */
export function anthropicChat(
  api: MessagesApi,
  modelString: string,
  opts: { summary?: boolean } = {},
): ToolChat {
  type Message = { role: "user" | "assistant"; content: string | Block[] };
  const summary = opts.summary ?? requestsThinkingSummary(modelString);
  return {
    provider: "anthropic",
    reasoningRequest: summary ? "summary" : "default",
    init: (prompt) => [{ role: "user", content: prompt } satisfies Message],
    toolSpecs: (tools: McpToolDef[]) =>
      tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    async send(messages, tools, maxTokens): Promise<ChatTurn> {
      const r = await api.send({
        model: modelString,
        max_tokens: maxTokens,
        messages,
        tools,
        ...(summary ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
      });
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
          // diagnostic only (already inside `output`): left out when the API does not report it, so "not reported" and "zero" stay different
          ...(usage.output_tokens_details?.thinking_tokens !== undefined
            ? { reasoning: usage.output_tokens_details.thinking_tokens }
            : {}),
        },
        assistant: content,
        reasoning: reasoningOfBlocks(content),
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
