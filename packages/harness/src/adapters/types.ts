export interface AdapterUsage {
  input: number;
  output: number;
  cached_input: number;
  reasoning: number;
}

export interface AdapterParams {
  temperature: number;
  max_tokens: number;
  cache_control?: "disabled";
}

export interface AdapterResult {
  text: string;
  usage: AdapterUsage;
  latency_ms: number;
  raw: unknown;
  /** Every forced deviation from the requested execution settings — build1-spec.md §3. */
  deviations: string[];
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
