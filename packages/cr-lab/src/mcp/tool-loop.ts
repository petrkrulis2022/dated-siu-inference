/**
 * The tool-using loop (D101, §16.8), the same for every provider: the model is given the task and the tools, asks for tool calls, the harness runs them against the MCP server and relays the
 * results, and the loop ends when the model answers, or on a limit. What differs between providers (the request shape, how a tool call and a tool result are written, how usage is counted) sits
 * behind `ToolChat`; this file knows none of it. No adapter in the harness sends tool definitions, so each `ToolChat` talks to its provider directly, with the trial's own key (never the print's).
 *
 * Every model call goes through the spend ledger's guard first (its projected cost is reserved against the daily cap and the provider's budget); a refused call ends the session and the
 * refusal is passed up, so a run stops instead of spending. A session also has its own limits: turns, tool calls, the size of the conversation, and a spend cap of its own, so one runaway
 * research session cannot eat the day. The assistant's turns are kept exactly as returned (thinking blocks included), which tool use with thinking requires.
 *
 * What is logged: every tool call (tool, arguments, whether it failed, the size of the result, latency) and every turn (tokens, cost, stop reason, retries). The results themselves are kept in
 * the session record, privately, because the grader needs exactly what the model was shown.
 */
import { D, type DecimalValue } from "@touchstone/sdk";
import type { Provider } from "../keys.js";
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
  maxTokensPerTurn: 32_000,
};

/** One turn of a model, as the loop needs it. `usage.output` already contains any reasoning tokens, as both Anthropic and OpenAI count them. */
export interface ChatReply {
  /** the model's text, "" if none */
  text: string;
  toolUses: { id: string; name: string; args: Record<string, unknown> }[];
  /** the model asked for tools and is waiting for their results */
  wantsTools: boolean;
  /** the provider's own stop reason */
  stopReason?: string;
  usage: { input: number; output: number; cachedInput: number; reasoning?: number };
  /** the assistant turn exactly as returned, to be sent back */
  assistant: unknown;
}

export interface ChatTurn {
  status: number;
  /** tries it took (a 429 or a server error is retried a couple of times; nothing else is) */
  attempts: number;
  reply?: ChatReply;
}

export interface ToolChat {
  readonly provider: Provider;
  /** a conversation that starts with the prompt */
  init(prompt: string): unknown[];
  /** the provider's own description of the tools */
  toolSpecs(tools: McpToolDef[]): unknown;
  send(messages: unknown[], tools: unknown, maxTokens: number): Promise<ChatTurn>;
  appendAssistant(messages: unknown[], assistant: unknown): void;
  appendToolResults(
    messages: unknown[],
    results: { id: string; text: string; isError: boolean }[],
  ): void;
}

/** Rough size of the conversation, in tokens (characters / 3: JSON and numbers tokenize poorly), used only to project cost before a call. */
export const approxTokens = (messages: unknown, tools: unknown): number =>
  Math.ceil((JSON.stringify(messages).length + JSON.stringify(tools).length) / 3);

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
  /** reasoning tokens the provider reported inside the output count, where it reports them (diagnostic: confirms the output already contains them) */
  reasoning_tokens?: number;
}

export type SessionLimit =
  "max-turns" | "max-tool-calls" | "context-limit" | "session-cap" | "spend-guard";

export interface SessionResult {
  /** the model's final reply, "" if it never gave one */
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

export interface RunLoopInput {
  chat: ToolChat;
  mcp: McpBackend;
  ledger: SpendLedger;
  modelId: string;
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
  const provider = input.chat.provider;
  const listed = await input.mcp.tools();
  const offered: McpToolDef[] = listed.filter((t) => MCP_DATA_TOOLS.includes(t.name));
  // everything the server lists that a model is not offered, and the tools held back by name whether or not the server lists them
  const withheld = [
    ...new Set([
      ...listed.filter((t) => !MCP_DATA_TOOLS.includes(t.name)).map((t) => t.name),
      ...MCP_WITHHELD_TOOLS,
    ]),
  ].sort();
  const tools = input.chat.toolSpecs(offered);
  const messages = input.chat.init(input.prompt);
  const result: SessionResult = {
    finalText: "",
    turns: [],
    toolCalls: [],
    relayed: [],
    usd: "0",
    tokens: { input: 0, output: 0 },
    latencyMs: 0,
    toolsOffered: offered.map((t) => t.name),
    toolsWithheld: withheld,
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
      provider,
    );
    if (spent.plus(projected).greaterThan(limits.maxSessionUsd)) {
      result.limit = "session-cap";
      return finish();
    }
    const turnStart = now();
    let sent: ChatTurn;
    let costUsd = "0";
    try {
      const out = await input.ledger.guard(
        provider,
        projected.toFixed(),
        { part: "mcp", model: input.modelId, key: input.keyName, what: `${input.what}#${turn}` },
        async () => {
          const r = await input.chat.send(messages, tools, limits.maxTokensPerTurn);
          const usd = r.reply
            ? usageCostUsd(
                {
                  input: r.reply.usage.input,
                  output: r.reply.usage.output,
                  cached_input: r.reply.usage.cachedInput,
                  reasoning: 0,
                },
                input.price,
                provider,
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
    const reply = sent.reply;
    if (sent.status !== 200 || reply === undefined) {
      result.error = `HTTP ${sent.status}`;
      return finish();
    }
    lastInput = reply.usage.input + reply.usage.cachedInput;
    result.tokens.input += reply.usage.input + reply.usage.cachedInput;
    result.tokens.output += reply.usage.output;
    result.turns.push({
      turn,
      input_tokens: reply.usage.input + reply.usage.cachedInput,
      output_tokens: reply.usage.output,
      usd: costUsd,
      ...(reply.stopReason !== undefined ? { stop_reason: reply.stopReason } : {}),
      latency_ms: now() - turnStart,
      retries: sent.attempts - 1,
      ...(reply.usage.reasoning !== undefined ? { reasoning_tokens: reply.usage.reasoning } : {}),
    });
    input.chat.appendAssistant(messages, reply.assistant);
    if (!reply.wantsTools) {
      result.finalText = reply.text;
      if (reply.stopReason !== undefined) result.stopReason = reply.stopReason;
      return finish();
    }

    const results: { id: string; text: string; isError: boolean }[] = [];
    for (const use of reply.toolUses) {
      if (result.toolCalls.length >= limits.maxToolCalls) {
        result.limit = "max-tool-calls";
        return finish();
      }
      const t0 = now();
      let res: { isError: boolean; text: string };
      if (!MCP_DATA_TOOLS.includes(use.name))
        res = { isError: true, text: `unknown tool ${JSON.stringify(use.name).slice(0, 60)}` };
      else
        try {
          res = await input.mcp.call(use.name, use.args);
        } catch (e) {
          res = {
            isError: true,
            text: e instanceof Error ? e.message.slice(0, 200) : "tool call failed",
          };
        }
      result.toolCalls.push({
        turn,
        tool: use.name,
        args: use.args,
        isError: res.isError,
        result_bytes: new TextEncoder().encode(res.text).length,
        latency_ms: now() - t0,
      });
      result.relayed.push({ tool: use.name, args: use.args, isError: res.isError, text: res.text });
      results.push({ id: use.id, text: res.text, isError: res.isError });
    }
    input.chat.appendToolResults(messages, results);
  }
  result.limit = "max-turns";
  return finish();
}
