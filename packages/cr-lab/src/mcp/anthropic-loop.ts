/**
 * The tool-using loop for Claude (D101, §16.8): the model is given the task and the tools, asks for tool calls, the harness runs them against the MCP server and relays the results, and the
 * loop ends when the model answers, or on a limit. No adapter in the harness sends tool definitions, so this talks to the Messages API directly, with the trial's own key (never the print's).
 *
 * Every model call goes through the spend ledger's guard first (its projected cost is reserved against the daily cap and the provider's budget); a refused call ends the session and the
 * refusal is passed up, so a run stops instead of spending. A session also has its own limits: turns, tool calls, the size of the conversation, and a spend cap of its own, so one runaway
 * research session cannot eat the day. Assistant turns are kept exactly as returned (thinking blocks included), which tool use with thinking requires.
 *
 * What is logged: every tool call (tool, arguments, whether it failed, the size of the result, latency) and every turn (tokens, cost, stop reason, retries). The results themselves are kept in the
 * session record, privately, because the grader needs exactly what the model was shown.
 */
import { D, type DecimalValue } from "@touchstone/sdk";
import type { Secret } from "../keys.js";
import { SpendStopped, type SpendLedger } from "../spend/ledger.js";
import { projectedTurnCostUsd, usageCostUsd, type ModelPrice } from "../runner/prices.js";
import type { McpBackend, McpToolDef } from "./types.js";
import { MCP_DATA_TOOLS, MCP_WITHHELD_TOOLS } from "./types.js";
import type { RelayedCall } from "./relayed.js";

export interface LoopLimits {
  maxTurns: number;
  maxToolCalls: number;
  /** stop when the conversation sent to the model passes this many input tokens */
  maxInputTokens: number;
  /** this session's own spend cap in USD, inside the daily cap */
  maxSessionUsd: string;
  /** the output allowance of each turn, thinking included */
  maxTokensPerTurn: number;
}

export const DEFAULT_LIMITS: LoopLimits = {
  maxTurns: 24,
  maxToolCalls: 40,
  maxInputTokens: 150_000,
  maxSessionUsd: "1.00",
  maxTokensPerTurn: 16_000,
};

type Block = { type: string; [k: string]: unknown };
interface Message {
  role: "user" | "assistant";
  content: string | Block[];
}
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

/** One request to the Messages API. `attempts` is how many tries it took (a 429 or a server error is retried a couple of times; nothing else is). */
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

export interface ToolCallLog {
  turn: number;
  tool: string;
  /** the arguments as the model gave them: entity ids and windows, never a credential */
  args: Record<string, unknown>;
  isError: boolean;
  result_bytes: number;
  latency_ms: number;
}

export interface TurnLog {
  turn: number;
  input_tokens: number;
  output_tokens: number;
  usd: string;
  stop_reason?: string;
  latency_ms: number;
  /** tries beyond the first, for a 429 or a server error */
  retries: number;
}

export type SessionLimit =
  "max-turns" | "max-tool-calls" | "context-limit" | "session-cap" | "spend-guard";

export interface SessionResult {
  /** the model's final reply (the text blocks of its last turn), "" if it never gave one */
  finalText: string;
  /** the provider's own stop reason of the last turn */
  stopReason?: string;
  limit?: SessionLimit;
  /** a sanitised reason when a model call failed: the error class and HTTP status, never a body */
  error?: string;
  turns: TurnLog[];
  toolCalls: ToolCallLog[];
  /** exactly what the model was shown, in order: the grader reads this */
  relayed: RelayedCall[];
  usd: string;
  tokens: { input: number; output: number };
  latencyMs: number;
  toolsOffered: string[];
  toolsWithheld: string[];
  /** set when the spend guard refused a call: the run must stop (the caller rethrows after recording the session) */
  stopped?: SpendStopped;
}

const textOf = (blocks: Block[]): string =>
  blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();

/** Rough size of the conversation, in tokens (characters / 3: JSON and numbers tokenize poorly), used only to project cost before a call. */
export const approxTokens = (messages: Message[], tools: unknown): number =>
  Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools).length) / 3);

export interface RunLoopInput {
  api: MessagesApi;
  mcp: McpBackend;
  ledger: SpendLedger;
  modelId: string;
  modelString: string;
  provider: "anthropic";
  keyName: string;
  price: ModelPrice;
  prompt: string;
  /** what the spend is booked against, e.g. the instance id */
  what: string;
  limits?: Partial<LoopLimits>;
  now?: () => number;
}

export async function runToolLoop(input: RunLoopInput): Promise<SessionResult> {
  const limits: LoopLimits = { ...DEFAULT_LIMITS, ...input.limits };
  const now = input.now ?? Date.now;
  const started = now();
  const offered: McpToolDef[] = (await input.mcp.tools()).filter((t) =>
    MCP_DATA_TOOLS.includes(t.name),
  );
  const tools = offered.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
  const messages: Message[] = [{ role: "user", content: input.prompt }];
  const result: SessionResult = {
    finalText: "",
    turns: [],
    toolCalls: [],
    relayed: [],
    usd: "0",
    tokens: { input: 0, output: 0 },
    latencyMs: 0,
    toolsOffered: offered.map((t) => t.name),
    toolsWithheld: [...MCP_WITHHELD_TOOLS],
  };
  let spent: DecimalValue = new D(0);
  const finish = (): SessionResult => {
    result.usd = spent.toFixed();
    result.latencyMs = now() - started;
    return result;
  };
  let lastInput = 0;

  for (let turn = 1; turn <= limits.maxTurns; turn++) {
    const estInput = Math.max(lastInput, approxTokens(messages, tools));
    if (estInput > limits.maxInputTokens) {
      result.limit = "context-limit";
      return finish();
    }
    const projected = projectedTurnCostUsd(
      estInput,
      limits.maxTokensPerTurn,
      input.price,
      "anthropic",
    );
    if (spent.plus(projected).greaterThan(limits.maxSessionUsd)) {
      result.limit = "session-cap";
      return finish();
    }
    const turnStart = now();
    let sent: Awaited<ReturnType<MessagesApi["send"]>>;
    let costUsd = "0";
    try {
      const out = await input.ledger.guard(
        input.provider,
        projected.toFixed(),
        { part: "mcp", model: input.modelId, key: input.keyName, what: `${input.what}#${turn}` },
        async () => {
          const r = await input.api.send({
            model: input.modelString,
            max_tokens: limits.maxTokensPerTurn,
            messages,
            tools,
          });
          const usage = ((r.json as ApiResponse | null)?.usage ?? {}) as ApiUsage;
          const usd =
            r.status === 200
              ? usageCostUsd(
                  {
                    input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
                    output: usage.output_tokens ?? 0,
                    cached_input: usage.cache_read_input_tokens ?? 0,
                    reasoning: 0,
                  },
                  input.price,
                  "anthropic",
                ).toFixed()
              : "0";
          return { usd, r };
        },
      );
      sent = out.r;
      costUsd = out.usd;
    } catch (err) {
      if (err instanceof SpendStopped) {
        result.stopped = err;
        result.limit = "spend-guard";
        return finish();
      }
      result.error = err instanceof Error ? err.name : "UnknownError";
      return finish();
    }
    spent = spent.plus(costUsd);
    if (sent.status !== 200) {
      result.error = `HTTP ${sent.status}`;
      return finish();
    }
    const resp = sent.json as ApiResponse;
    const content = resp.content ?? [];
    const usage = resp.usage ?? {};
    lastInput =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0);
    result.tokens.input += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    result.tokens.output += usage.output_tokens ?? 0;
    result.turns.push({
      turn,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      usd: costUsd,
      ...(resp.stop_reason !== undefined ? { stop_reason: resp.stop_reason } : {}),
      latency_ms: now() - turnStart,
      retries: sent.attempts - 1,
    });
    // the assistant turn is kept exactly as returned
    messages.push({ role: "assistant", content });
    if (resp.stop_reason !== "tool_use") {
      result.finalText = textOf(content);
      if (resp.stop_reason !== undefined) result.stopReason = resp.stop_reason;
      return finish();
    }

    const uses = content.filter((b) => b.type === "tool_use");
    const results: Block[] = [];
    for (const use of uses) {
      if (result.toolCalls.length >= limits.maxToolCalls) {
        result.limit = "max-tool-calls";
        return finish();
      }
      const name = String(use.name ?? "");
      const args = (typeof use.input === "object" && use.input !== null ? use.input : {}) as Record<
        string,
        unknown
      >;
      const t0 = now();
      let res: { isError: boolean; text: string };
      if (!MCP_DATA_TOOLS.includes(name))
        res = { isError: true, text: `unknown tool ${JSON.stringify(name).slice(0, 60)}` };
      else
        try {
          res = await input.mcp.call(name, args);
        } catch (e) {
          res = {
            isError: true,
            text: e instanceof Error ? e.message.slice(0, 200) : "tool call failed",
          };
        }
      result.toolCalls.push({
        turn,
        tool: name,
        args,
        isError: res.isError,
        result_bytes: new TextEncoder().encode(res.text).length,
        latency_ms: now() - t0,
      });
      result.relayed.push({ tool: name, args, isError: res.isError, text: res.text });
      results.push({
        type: "tool_result",
        tool_use_id: String(use.id ?? ""),
        content: res.text,
        ...(res.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }
  result.limit = "max-turns";
  return finish();
}
