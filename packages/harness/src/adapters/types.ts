export interface AdapterUsage {
  input: number;
  output: number;
  cached_input: number;
  reasoning: number;
}

/**
 * Thinking, as the Anthropic adapter can ask for it. Optional and read only by that adapter; nothing in the print's path sets it.
 *  - `manual`: `thinking: {type: "enabled", budget_tokens}` — the only thinking claude-haiku-4-5 has, off unless asked for, and incompatible with
 *    setting a temperature. `budget_tokens` must be at least 1,024 and below `max_tokens`.
 *  - `summarized`: `thinking: {type: "adaptive", display: "summarized"}` — for the models whose adaptive thinking is already on (claude-sonnet-5),
 *    which hides its text by default: this asks for a summary of it and does not change what the model does.
 */
export type AdapterThinking = { mode: "manual"; budget_tokens: number } | { mode: "summarized" };

export interface AdapterParams {
  temperature: number;
  max_tokens: number;
  cache_control?: "disabled";
  /** Send no temperature at all, so the provider's default sampling applies. For comparisons in which one arm cannot set a temperature. */
  omit_temperature?: true;
  /** Ask for thinking (Anthropic adapter only; see `AdapterThinking`). */
  thinking?: AdapterThinking;
}

/** What a call actually sent, as opposed to what was asked for: the sampling the result was produced under. */
export interface AdapterSent {
  /** The temperature sent, or "provider-default" when none was (asked not to send one, or the provider rejected the one requested). */
  temperature: number | "provider-default";
  /** The thinking configuration sent, if any. */
  thinking?: AdapterThinking;
}

export interface AdapterResult {
  text: string;
  usage: AdapterUsage;
  latency_ms: number;
  raw: unknown;
  /** Every forced deviation from the requested execution settings — build1-spec.md §3. */
  deviations: string[];
  /**
   * The sampling the successful request was actually sent with. Optional so every existing mocked result stays valid; the Anthropic adapter fills it.
   * It is the record of what ran, whether or not a deviation was needed to get there.
   */
  sent?: AdapterSent;
  /** The provider's own real reason the completion ended (e.g. "end_turn"/"stop_reason" for
   * Anthropic, "finish_reason" for OpenAI-shaped APIs, "finishReason" for Google) — never
   * inferred. Added 2026-09-26: a real live call (claude-sonnet-5, P5 window 1) returned no text
   * at all for a real, separately-billed $0.24 request, and there was nothing persisted anywhere
   * to tell truncation, a non-text content block, and dropped reasoning tokens apart after the
   * fact. Optional so every existing mocked AdapterResult literal in this repo's own tests stays
   * valid unchanged — only the four real adapters populate it. */
  stopReason?: string;
  /** The real type of every content block/part the provider returned (e.g. Anthropic's own
   * `content[].type`: "text" | "tool_use" | "thinking" | ...) — lets a caller tell "the model
   * wrote its answer somewhere this parser doesn't read" apart from "the model wrote nothing."
   * Same optionality/rationale as `stopReason`. */
  contentBlockTypes?: string[];
}

export type Adapter = (
  modelString: string,
  prompt: string,
  params: AdapterParams,
) => Promise<AdapterResult>;

/**
 * Bounds the reasoning-accommodation retry every adapter implements the same way — see each
 * adapter's own `callX` doc comment. docs/methodology.md's Quality gates section states this
 * multiple as a published, versioned methodology fact, not an implementation detail: the rule
 * is architectural (any provider reporting reasoning tokens separately, whose thinking cannot
 * be disabled, gets this same accommodation), never a per-model allowance, and this constant is
 * the single place that bound is defined so every adapter reads the same number.
 */
export const REASONING_BUDGET_MULTIPLE = 3;

export class AdapterHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "AdapterHttpError";
  }
}
