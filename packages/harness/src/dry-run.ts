import type { ModelRegistryEntry, PriceSnapshot } from "@datum/sdk";
import type { TaskInstance } from "@datum/basket";
import { sumCosts, tokenCost } from "./decimal.js";

export interface DryRunLineItem {
  model_id: string;
  task_class: string;
  instance_id: string;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_cost_usd: string;
}

export interface DryRunResult {
  price_snapshot_id: string;
  line_items: DryRunLineItem[];
  total_usd: string;
  /** Registry models with no price in the snapshot — excluded from the total, never silently priced at 0. */
  unpriced_models: string[];
}

// A commonly-cited rough approximation (OpenAI's own included among others), not real
// tokenization — no tokenizer dependency for a pre-flight estimate. Deliberately generous:
// dry-run's purpose is "don't let real spend exceed what I was shown."
const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimateInputTokens(prompt: string): number {
  return Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Estimates total cost across every (registry model x basket instance) pair, using the
 * given price snapshot and each instance's own `params.max_tokens` as a worst-case output
 * estimate (we can't know the real output size before calling — this is the honest upper
 * bound, not an optimistic guess). Makes no network call.
 */
export function estimateCost(
  registry: ModelRegistryEntry[],
  priceSnapshot: PriceSnapshot,
  instances: TaskInstance[],
): DryRunResult {
  const priceByModelId = new Map(
    [...priceSnapshot.entries].map((entry) => [entry.model_id, entry]),
  );
  const lineItems: DryRunLineItem[] = [];
  const unpriced = new Set<string>();

  for (const model of registry) {
    const price = priceByModelId.get(model.id);
    if (!price) {
      unpriced.add(model.id);
      continue;
    }
    for (const instance of instances) {
      const estimatedInputTokens = estimateInputTokens(instance.prompt);
      const estimatedOutputTokens = instance.params.max_tokens;
      const cost = sumCosts([
        tokenCost(estimatedInputTokens, price.price_in_usd_per_1m),
        tokenCost(estimatedOutputTokens, price.price_out_usd_per_1m),
      ]);
      lineItems.push({
        model_id: model.id,
        task_class: instance.task_class,
        instance_id: instance.instance_id,
        estimated_input_tokens: estimatedInputTokens,
        estimated_output_tokens: estimatedOutputTokens,
        estimated_cost_usd: cost,
      });
    }
  }

  return {
    price_snapshot_id: priceSnapshot.snapshot_id,
    line_items: lineItems,
    total_usd: sumCosts(lineItems.map((item) => item.estimated_cost_usd)),
    unpriced_models: [...unpriced],
  };
}

export function formatDryRunReport(result: DryRunResult): string {
  const lines: string[] = [`Dry run against price snapshot ${result.price_snapshot_id}`, ""];

  const byModel = new Map<string, DryRunLineItem[]>();
  for (const item of result.line_items) {
    const list = byModel.get(item.model_id) ?? [];
    list.push(item);
    byModel.set(item.model_id, list);
  }
  for (const [modelId, items] of byModel) {
    const subtotal = sumCosts(items.map((i) => i.estimated_cost_usd));
    lines.push(`  ${modelId}: $${subtotal} (${items.length} instances)`);
  }

  if (result.unpriced_models.length > 0) {
    lines.push(
      "",
      `Unpriced (excluded from total — no price snapshot entry): ${result.unpriced_models.join(", ")}`,
    );
  }

  lines.push("", `Estimated total: $${result.total_usd}`);
  lines.push(
    "(Upper bound: output tokens estimated at each task's max_tokens ceiling, not typical usage.)",
  );
  return lines.join("\n");
}
