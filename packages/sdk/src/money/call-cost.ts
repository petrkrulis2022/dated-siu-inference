import { D, type DecimalValue } from "./decimal.js";

/**
 * The one place a call's dollar cost is computed from its token counts (docs/methodology.md, rules-2026-11-21). The print, the demo agents, the
 * MCP server, the gate-market testbed and cr-lab all price calls here. Four copies of the formula used to exist, and a fix to one (the cached
 * token double count, 2026-11-21) did not reach the others.
 *
 * A token count means what the code that recorded it made it mean, so the caller states the convention its usage follows:
 *  - `cachedInsideInput`: `input` already includes the cached prompt tokens, which are then priced once, at the cached rate, and the rest of the
 *    prompt at the input rate. Otherwise cached tokens are added on top of `input`.
 *  - `reasoningInsideOutput`: `output` already includes the reasoning tokens, so they are not added again. Otherwise they are added at the
 *    output rate.
 * Where no cached rate is published, cached tokens are priced at the input rate (inside the prompt) or not at all (apart from it), never at a
 * guessed rate. Decimal arithmetic throughout (invariant 4); rounding is the caller's, at publication.
 */
export interface CallPrices {
  priceInUsdPer1M: string;
  priceOutUsdPer1M: string;
  /** Absent when the price source publishes no separate cached rate. */
  priceCachedInUsdPer1M?: string;
}

export interface CallUsage {
  input: number;
  output: number;
  cached_input?: number;
  reasoning?: number;
}

export interface UsageConvention {
  cachedInsideInput: boolean;
  reasoningInsideOutput: boolean;
}

const MILLION = new D(1_000_000);

export function callCostUsd(usage: CallUsage, prices: CallPrices, convention: UsageConvention): DecimalValue {
  const cached = usage.cached_input ?? 0;
  const reasoning = usage.reasoning ?? 0;
  const cachedRate = prices.priceCachedInUsdPer1M;
  let promptAtInputRate = usage.input;
  let cachedAtCachedRate = 0;
  if (cached > 0 && cachedRate !== undefined) {
    if (convention.cachedInsideInput) {
      if (cached > usage.input) throw new Error(`cached_input ${cached} exceeds input ${usage.input}, of which it is supposed to be part.`);
      promptAtInputRate = usage.input - cached;
    }
    cachedAtCachedRate = cached;
  }
  const outputTokens = convention.reasoningInsideOutput ? usage.output : usage.output + reasoning;
  let total = new D(promptAtInputRate)
    .dividedBy(MILLION)
    .times(prices.priceInUsdPer1M)
    .plus(new D(outputTokens).dividedBy(MILLION).times(prices.priceOutUsdPer1M));
  if (cachedAtCachedRate > 0) total = total.plus(new D(cachedAtCachedRate).dividedBy(MILLION).times(cachedRate as string));
  return total;
}

/**
 * How the harness adapters (`@touchstone/harness`) record a call's usage, per provider: the convention of every RunRecord, so of the print, the
 * trial's dry run and the gate-market testbed.
 *  - anthropic: `input_tokens` excludes cache reads, recorded apart as cached_input; `output_tokens` contains the thinking tokens (checked on the
 *    first live CR dry run, 2026-10-17).
 *  - openai: `prompt_tokens` includes `cached_tokens`; `completion_tokens` includes `reasoning_tokens` (OpenAI's usage reports them as a breakdown).
 *  - google: `promptTokenCount` includes `cachedContentTokenCount`; `thoughtsTokenCount` is apart from `candidatesTokenCount` (its
 *    totalTokenCount is prompt + candidates + thoughts), billed at the output rate.
 *  - xai: `prompt_tokens` includes the cached tokens; reasoning is apart from `completion_tokens` (its billed `cost_in_usd_ticks` equals
 *    output + reasoning at the output rate on every call checked).
 *  - openrouter and the other OpenAI-compatible hosts: `prompt_tokens` includes the cached tokens (every cached OpenRouter call's billed figure
 *    matches); reasoning as the print has always priced it, apart, unverified because no constituent there has yet reported any: the daily price
 *    check compares it with the billed figure when one does.
 */
const RUN_RECORD_USAGE: Readonly<Record<string, UsageConvention>> = {
  anthropic: { cachedInsideInput: false, reasoningInsideOutput: true },
  openai: { cachedInsideInput: true, reasoningInsideOutput: true },
  google: { cachedInsideInput: true, reasoningInsideOutput: false },
  xai: { cachedInsideInput: true, reasoningInsideOutput: false },
  openrouter: { cachedInsideInput: true, reasoningInsideOutput: false },
  together: { cachedInsideInput: true, reasoningInsideOutput: false },
  fireworks: { cachedInsideInput: true, reasoningInsideOutput: false },
  groq: { cachedInsideInput: true, reasoningInsideOutput: false },
};

export function runRecordUsageConvention(provider: string): UsageConvention {
  const convention = RUN_RECORD_USAGE[provider];
  if (!convention) throw new Error(`No usage convention is stated for provider "${provider}": add it to call-cost.ts before pricing its calls.`);
  return convention;
}

/** cr-lab's own chat loops (mcp/openai-loop.ts, mcp/anthropic-loop.ts) record `input` without the cached tokens, for both providers, and leave
 * reasoning inside `output` (OpenAI's completion_tokens, Anthropic's output_tokens). */
export const CHAT_LOOP_USAGE: UsageConvention = { cachedInsideInput: false, reasoningInsideOutput: true };
