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
