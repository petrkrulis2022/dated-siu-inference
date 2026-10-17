/**
 * One attempt: one instance, one model, no retries of ours (§16.7: a failure counts zero). The call goes through the spend ledger's guard, so its projected cost is reserved
 * against the daily cap and the provider's budget BEFORE it is made and a refused call never starts (`SpendStopped` is not caught here: it stops the whole run).
 * Whatever else happens (a provider error, an empty or truncated reply, a wrong answer) becomes a record with a class, and the run goes on.
 */
import { REASONING_BUDGET_MULTIPLE, type Adapter, type AdapterParams } from "@touchstone/harness";
import type { ModelRegistryEntry } from "@touchstone/sdk";
import type { Provider } from "../keys.js";
import { SpendStopped, type SpendLedger } from "../spend/ledger.js";
import type { Part } from "../spend/types.js";
import type { Instance } from "../tasks/instances.js";
import { gradeAnswer } from "./grade.js";
import { projectedCostUsd, usageCostUsd, type ModelPrice } from "./prices.js";
import type { PromptBundle } from "./prompts.js";
import type { AnswerRecord } from "./records.js";
import { classify } from "./taxonomy.js";

/** The output allowance per task, in tokens, covering the JSON answer and the reasoning some models cannot switch off. The seat's own `params.max_tokens` is only a default. */
export const MAX_OUTPUT_TOKENS: Readonly<Record<Instance["task"], number>> = {
  "CR-VS": 8000,
  "CR-PL": 4000,
  "CR-UO": 4000,
  "CR-SM": 4000,
};

/** One model in a run: its registry entry, which trial key pays, what it costs, and the adapter that calls it. */
export interface Seat {
  modelId: string;
  /** the provider's own model string, sent in the request */
  modelString: string;
  provider: Provider;
  /** the `.env` name of the key that pays (never its value) */
  keyName: string;
  price: ModelPrice;
  adapter: Adapter;
  params: AdapterParams;
  entry?: Pick<ModelRegistryEntry, "id" | "provider">;
}

/** An error reduced to what is safe to keep: its class and, for an HTTP error, the status. Never the message or body, which can echo the request. */
export function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? `${err.name} HTTP ${status}` : err.name;
  }
  return "UnknownError";
}

export interface RunAnswerInput {
  ledger: SpendLedger;
  seat: Seat;
  instance: Instance;
  bundle: PromptBundle;
  window: string;
  daySha256: string;
  part?: Extract<Part, "snapshot" | "dry-run">;
  now?: () => Date;
}

export async function runAnswer(input: RunAnswerInput): Promise<AnswerRecord> {
  const { ledger, seat, instance, bundle } = input;
  const part = input.part ?? "snapshot";
  const now = input.now ?? (() => new Date());
  const params: AdapterParams = { ...seat.params, max_tokens: MAX_OUTPUT_TOKENS[instance.task] };
  const projected = projectedCostUsd(
    bundle.approxTokens,
    params.max_tokens,
    REASONING_BUDGET_MULTIPLE,
    seat.price,
  ).toFixed();

  const base = {
    schema: 1 as const,
    window: input.window,
    part,
    task: instance.task,
    instance: instance.id,
    model: seat.modelId,
    provider: seat.provider,
    key: seat.keyName,
    data_sha256: bundle.dataSha256,
    prompt_sha256: bundle.promptSha256,
    day_sha256: input.daySha256,
  };

  let outcome: Awaited<ReturnType<Adapter>> | undefined;
  let usd = "0";
  let callError: string | undefined;
  try {
    const out = await ledger.guard(
      seat.provider,
      projected,
      { part, model: seat.modelId, key: seat.keyName, what: instance.id },
      async () => {
        const res = await seat.adapter(seat.modelString, bundle.text, params);
        return { usd: usageCostUsd(res.usage, seat.price).toFixed(), res };
      },
    );
    outcome = out.res;
    usd = out.usd;
  } catch (err) {
    if (err instanceof SpendStopped) throw err;
    callError = sanitizeError(err);
  }

  const text = outcome?.text ?? "";
  const verdict =
    callError === undefined && text.trim() !== "" ? gradeAnswer(instance, text) : undefined;
  const cls = classify({
    instance,
    text,
    ...(callError !== undefined ? { callError } : {}),
    ...(outcome?.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
    ...(verdict !== undefined ? { verdict } : {}),
  });
  const passed = verdict?.passed === true;
  return {
    ...base,
    at: now().toISOString(),
    passed,
    fenced: verdict?.fenced ?? false,
    ...(cls.primary !== undefined ? { primary_failure: cls.primary } : {}),
    failure_classes: cls.classes,
    failures: verdict?.failures ?? [],
    usd,
    tokens: {
      input: outcome?.usage.input ?? 0,
      output: outcome?.usage.output ?? 0,
      reasoning: outcome?.usage.reasoning ?? 0,
      cached_input: outcome?.usage.cached_input ?? 0,
    },
    latency_ms: outcome?.latency_ms ?? 0,
    ...(outcome?.stopReason !== undefined ? { stop_reason: outcome.stopReason } : {}),
    deviations: outcome?.deviations ?? [],
    ...(callError !== undefined ? { error: callError } : {}),
    raw_output: text,
  };
}
