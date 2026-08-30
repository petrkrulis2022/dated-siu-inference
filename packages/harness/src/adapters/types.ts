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
