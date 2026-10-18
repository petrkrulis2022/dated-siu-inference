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
  opts: { drop?: string } = {},
): Planned[] {
  switch (instance.task) {
    case "CR-VS": {
      const { months } = vsMonthly(day, instance.params.endMonth);
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

export type AgentKind = "researcher" | "partial" | "lazy" | "looper" | "chatty";

const toolUse = (n: number, [name, input]: Planned): Block => ({
  type: "tool_use",
  id: `toolu_${n}`,
  name,
  input,
});

/** A Messages API that plays `kind` for `instance`. `requests` records every request body it was sent. */
export function standInMessagesApi(
  kind: AgentKind,
  instance: Instance,
  day: DayData,
): MessagesApi & { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
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
      : kind === "partial"
        ? readPlan(instance, day, dropTop !== undefined ? { drop: dropTop } : {})
        : [];
  return {
    requests,
    async send(body) {
      const messages = structuredClone(body.messages) as Message[];
      requests.push(structuredClone(body));
      const turn = messages.filter((m) => m.role === "assistant").length;
      const input_tokens = approxTokens(messages, body.tools);
      const reply = (content: Block[], stop_reason: string, output_tokens = 80): StepOut => ({
        content,
        stop_reason,
        usage: { input_tokens, output_tokens },
      });
      let out: StepOut;
      if (kind === "looper") out = reply([toolUse(turn, ["tabular_catalog", {}])], "tool_use");
      else if (kind === "chatty")
        out = reply([toolUse(turn, ["tabular_catalog", {}])], "tool_use", 15_000);
      else if (kind === "lazy") out = reply([{ type: "text", text: "{}" }], "end_turn");
      else if (turn < plan.length) {
        // a thinking block before the first call, to show it is carried back unchanged
        const blocks: Block[] = [toolUse(turn, plan[turn] as Planned)];
        out = reply(
          turn === 0
            ? [{ type: "thinking", thinking: "plan the reads", signature: "sig-1" }, ...blocks]
            : blocks,
          "tool_use",
        );
      } else {
        const key = referenceFor(
          instance,
          dayFromRelayed(day.window, relayedFromMessages(messages)),
        );
        const text =
          key === undefined
            ? "{}"
            : referenceAnswerJson({ ...instance, reference: key } as Instance);
        out = reply([{ type: "text", text }], "end_turn", 600);
      }
      return { status: 200, json: out, attempts: 1 };
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
