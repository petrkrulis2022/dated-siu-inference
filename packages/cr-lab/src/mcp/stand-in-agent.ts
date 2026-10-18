/**
 * Stand-in agents for trying the MCP loop without spending anything: a scripted Messages API that plays a model. It reads the conversation it is sent, as a model would, and replies with tool
 * calls or an answer, so the loop, the limits, the logs and the grader are exercised end to end. The "researcher" reads the data a careful agent would and answers from what it was shown; the
 * others misbehave in one named way each (read too little, read nothing, never stop, burn tokens). None of this calls a provider.
 */
import { addDays } from "../data-desk/dates.js";
import { referenceAnswerJson } from "../runner/prompts.js";
import type { DayData } from "../tasks/day-data.js";
import type { Instance } from "../tasks/instances.js";
import { vsMonthly } from "../tasks/solve.js";
import { approxTokens, type MessagesApi } from "./anthropic-loop.js";
import type { ChatCompletionsApi } from "./openai-loop.js";
import { dayFromRelayed, referenceFor, type RelayedCall } from "./relayed.js";

type Block = { type: string; [k: string]: unknown };
interface Message {
  role: "user" | "assistant";
  content: string | Block[];
}
export interface StepOut {
  content: Block[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}
export type Planned = [tool: string, args: Record<string, unknown>];

/** Rebuilds what the model was shown from the conversation itself: each tool_use paired with the tool_result that answered it. */
export function relayedFromMessages(messages: readonly Message[]): RelayedCall[] {
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const out: RelayedCall[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (m.role === "assistant" && b.type === "tool_use")
        uses.set(String(b.id), {
          name: String(b.name),
          input: (b.input ?? {}) as Record<string, unknown>,
        });
      if (m.role === "user" && b.type === "tool_result") {
        const u = uses.get(String(b.tool_use_id));
        if (u)
          out.push({
            tool: u.name,
            args: u.input,
            isError: b.is_error === true,
            text: String(b.content ?? ""),
          });
      }
    }
  }
  return out;
}

const chunks = <T>(xs: readonly T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** The reads a careful agent makes to answer an instance, from the snapshot day's catalog (so the plan names real ids, as a model finds them through the tools). */
export function readPlan(
  instance: Instance,
  day: DayData,
  opts: { drop?: string; careless?: boolean } = {},
): Planned[] {
  /** a careful agent names the metric fields it needs; a careless one leaves `selections` out and is sent every metric the model has (96 for the volume model) */
  const pick = (fields: string[]): Record<string, unknown> =>
    opts.careless === true ? {} : { selections: fields };
  switch (instance.task) {
    case "CR-VS": {
      const { months } = vsMonthly(day, instance.params.endMonth, instance.params.months ?? 12);
      const ids = day.perpVenues.filter((v) => v !== opts.drop);
      return [
        ["timeseries_catalog", {}],
        ["tabular_data", { model: "perp-dex-protocols", pageSize: 100 }],
        ...chunks(ids, 10).map((series): Planned => [
          "timeseries_data",
          {
            model: "perp-dex-protocols",
            granularity: "1d",
            series,
            ...pick(["volumeUSD"]),
            start: (months[0] as { start: string }).start,
            end: (months[months.length - 1] as { end: string }).end,
          },
        ]),
      ];
    }
    case "CR-PL": {
      const id =
        opts.drop !== undefined
          ? (day.lendingProtocols.find((p) => p !== instance.params.protocolId) as string)
          : instance.params.protocolId;
      return [
        ["tabular_data", { model: "lending-protocols", pageSize: 100 }],
        [
          "timeseries_data",
          {
            model: "lending-protocols",
            granularity: "1d",
            series: [id],
            ...pick(["fees-usd", "revenue-usd", "interest-usd", "net-interest-income-usd"]),
            start: instance.params.start,
            end: instance.params.end,
          },
        ],
      ];
    }
    case "CR-SM": {
      const model =
        instance.params.dimension === "chain" ? "stablecoins-by-chain" : "stablecoins-by-issuer";
      const ids = [...day.stablecoins[instance.params.dimension].keys()].filter(
        (i) => i !== opts.drop,
      );
      return chunks(ids, 10).map((series): Planned => [
        "timeseries_data",
        {
          model,
          granularity: "1d",
          series,
          ...pick(["circulatingSupplyUSD"]),
          start: addDays(day.window, -90),
          end: addDays(day.window, 1),
          bounds: true,
        },
      ]);
    }
    case "CR-UO":
      throw new Error("CR-UO has no MCP read plan until the live tool list is known");
  }
}

export type AgentKind = "researcher" | "partial" | "careless" | "lazy" | "looper" | "chatty";

const toolUse = (n: number, [name, input]: Planned): Block => ({
  type: "tool_use",
  id: `toolu_${n}`,
  name,
  input,
});

/** What a stand-in agent does next: one tool call, or a final answer, and how many tokens it "wrote" doing it. */
interface Decision {
  use?: Planned;
  text?: string;
  outputTokens: number;
  /** a thinking block before the first call (Claude's wire format only), to show it is carried back unchanged */
  thinkFirst?: boolean;
  /** visible text written beside the call: what the agent says it is doing */
  narrate?: string;
}

/** The plan and the choices of a stand-in agent, independent of any provider's wire format. */
function agentFor(kind: AgentKind, instance: Instance, day: DayData) {
  const dropTop =
    instance.task === "CR-VS"
      ? (instance.reference.venues[0] as string)
      : instance.task === "CR-SM"
        ? (instance.reference.top5[0]?.id as string)
        : instance.task === "CR-PL"
          ? "other"
          : undefined;
  const plan: Planned[] =
    kind === "researcher"
      ? readPlan(instance, day)
      : kind === "careless"
        ? readPlan(instance, day, { careless: true })
        : kind === "partial"
          ? readPlan(instance, day, dropTop !== undefined ? { drop: dropTop } : {})
          : [];
  return (turn: number, relayed: () => RelayedCall[]): Decision => {
    if (kind === "looper") return { use: ["tabular_catalog", {}], outputTokens: 80 };
    if (kind === "chatty") return { use: ["tabular_catalog", {}], outputTokens: 15_000 };
    if (kind === "lazy") return { text: "{}", outputTokens: 80 };
    if (turn < plan.length)
      return {
        use: plan[turn] as Planned,
        outputTokens: 80,
        thinkFirst: turn === 0,
        ...(turn === 0
          ? { narrate: "I will list what the server holds, then read what the question needs." }
          : {}),
      };
    const key = referenceFor(instance, dayFromRelayed(day.window, relayed()));
    const text =
      key === undefined ? "{}" : referenceAnswerJson({ ...instance, reference: key } as Instance);
    return { text, outputTokens: 600 };
  };
}

/** A Messages API (Claude's wire format) that plays `kind` for `instance`. `requests` records every request body it was sent. */
export function standInMessagesApi(
  kind: AgentKind,
  instance: Instance,
  day: DayData,
): MessagesApi & { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  const decide = agentFor(kind, instance, day);
  return {
    requests,
    async send(body) {
      const messages = structuredClone(body.messages) as Message[];
      requests.push(structuredClone(body));
      const turn = messages.filter((m) => m.role === "assistant").length;
      const input_tokens = approxTokens(messages, body.tools);
      const d = decide(turn, () => relayedFromMessages(messages));
      const out: StepOut =
        d.use !== undefined
          ? {
              content: [
                // thinking text comes back only when a summary was asked for, as Sonnet does; otherwise the block is there and its text is not
                ...(d.thinkFirst
                  ? [
                      {
                        type: "thinking",
                        thinking: body.thinking === undefined ? "" : "plan the reads",
                        signature: "sig-1",
                      },
                    ]
                  : []),
                ...(d.narrate !== undefined ? [{ type: "text", text: d.narrate }] : []),
                toolUse(turn, d.use),
              ],
              stop_reason: "tool_use",
              usage: { input_tokens, output_tokens: d.outputTokens },
            }
          : {
              content: [{ type: "text", text: d.text ?? "" }],
              stop_reason: "end_turn",
              usage: { input_tokens, output_tokens: d.outputTokens },
            };
      return { status: 200, json: out, attempts: 1 };
    },
  };
}

type OpenAiMessage = {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

/** Rebuilds what the model was shown from an OpenAI-style conversation: each tool call paired with the `tool` message that answered it. */
export function relayedFromOpenAiMessages(messages: readonly OpenAiMessage[]): RelayedCall[] {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const out: RelayedCall[] = [];
  for (const m of messages) {
    if (m.role === "assistant")
      for (const c of m.tool_calls ?? [])
        calls.set(c.id, {
          name: c.function.name,
          input: JSON.parse(c.function.arguments) as Record<string, unknown>,
        });
    if (m.role === "tool") {
      const u = calls.get(String(m.tool_call_id));
      const text = String(m.content ?? "");
      if (u)
        out.push({
          tool: u.name,
          args: u.input,
          isError: text.startsWith("Error: "),
          text: text.replace(/^Error: /, ""),
        });
    }
  }
  return out;
}

/** A Chat Completions API (GPT's wire format) that plays `kind` for `instance`. */
export function standInChatCompletionsApi(
  kind: AgentKind,
  instance: Instance,
  day: DayData,
): ChatCompletionsApi & { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  const decide = agentFor(kind, instance, day);
  return {
    requests,
    async send(body) {
      const messages = structuredClone(body.messages) as OpenAiMessage[];
      requests.push(structuredClone(body));
      const turn = messages.filter((m) => m.role === "assistant").length;
      const prompt_tokens = approxTokens(messages, body.tools);
      const d = decide(turn, () => relayedFromOpenAiMessages(messages));
      const message =
        d.use !== undefined
          ? {
              role: "assistant",
              content: d.narrate ?? null,
              tool_calls: [
                {
                  id: `call_${turn}`,
                  type: "function",
                  function: { name: d.use[0], arguments: JSON.stringify(d.use[1]) },
                },
              ],
            }
          : { role: "assistant", content: d.text ?? "" };
      return {
        status: 200,
        json: {
          choices: [{ message, finish_reason: d.use !== undefined ? "tool_calls" : "stop" }],
          usage: {
            prompt_tokens,
            completion_tokens: d.outputTokens,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        },
        attempts: 1,
      };
    },
  };
}

/**
 * One scripted agent for a whole day: the request is routed to the instance whose MCP prompt it carries (the first message is the prompt, exactly), so a single `apiFor` serves every instance
 * and model. A request whose prompt matches no instance is refused as a bad request.
 */
export function routedStandInApi(
  kind: AgentKind,
  instances: readonly Instance[],
  day: DayData,
  promptOf: (i: Instance) => string,
): MessagesApi {
  return {
    async send(body) {
      const first = (body.messages as { content: unknown }[])[0]?.content;
      const instance = instances.find((i) => promptOf(i) === first);
      if (instance === undefined)
        return { status: 400, json: { error: { type: "invalid_request_error" } }, attempts: 1 };
      return standInMessagesApi(kind, instance, day).send(body);
    },
  };
}
