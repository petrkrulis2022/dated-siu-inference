/**
 * Finds the discarded first call of each retried run, from its saved raw response (docs/methodology.md, rules-2026-10-24).
 *
 * When a provider reports reasoning separately and the completion was cut off by the task's budget, the adapter retries with a larger one and keeps BOTH responses in the run's raw file
 * (`{ truncated, final }`). The record's usage is the sum of the two since the fix of 2026-09-13; a record from before it holds the final call only, and its raw file does not have the
 * truncated response at all. So a record is adjusted only when its usage is exactly the sum of the two calls the raw file holds: a record that is not (older, or a raw file that is missing or
 * unreadable) is left as it is, never guessed.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord } from "@touchstone/sdk";
import {
  successfulCallVariant,
  type DiscardedFirstCalls,
  type PolicyVariant,
} from "../compute/sensitivity.js";

type Usage = RunRecord["usage"];

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;

/** The usage one provider response reports, in the record's own terms, for the three response shapes the adapters keep. */
export function usageOfRawResponse(response: unknown): Usage | undefined {
  const r = obj(response);
  if (r === undefined) return undefined;
  const g = obj(r.usageMetadata); // Google
  if (g !== undefined)
    return {
      input: num(g.promptTokenCount),
      output: num(g.candidatesTokenCount),
      cached_input: num(g.cachedContentTokenCount),
      reasoning: num(g.thoughtsTokenCount),
    };
  const u = obj(r.usage);
  if (u === undefined) return undefined;
  if ("input_tokens" in u) // Anthropic
    return {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cached_input: num(u.cache_read_input_tokens),
      reasoning: num(obj(u.output_tokens_details)?.thinking_tokens),
    };
  if ("prompt_tokens" in u) // OpenAI
    return {
      input: num(u.prompt_tokens),
      output: num(u.completion_tokens),
      cached_input: num(obj(u.prompt_tokens_details)?.cached_tokens),
      reasoning: num(obj(u.completion_tokens_details)?.reasoning_tokens),
    };
  return undefined;
}

const sameUsage = (a: Usage, b: Usage): boolean =>
  a.input === b.input && a.output === b.output && a.cached_input === b.cached_input && a.reasoning === b.reasoning;

/**
 * The discarded first call of every run in `records` that has one, by run id. `dirs` are the run directories to look for each record's raw file in, in order (the print's own, and the days
 * of any carried-forward rows). A record with no truncated response, or whose usage is not the sum of the two, is left out.
 */
export async function loadDiscardedFirstCalls(
  records: readonly RunRecord[],
  dirs: readonly string[],
): Promise<DiscardedFirstCalls> {
  const out = new Map<string, Usage>();
  for (const r of records) {
    if (!r.deviations?.some((d) => d.includes("completion truncated by mandatory reasoning"))) continue;
    if (r.raw_response_ref === undefined) continue;
    let raw: unknown;
    for (const dir of dirs) {
      try {
        raw = JSON.parse(await readFile(join(dir, r.raw_response_ref), "utf-8"));
        break;
      } catch {
        /* not in this directory */
      }
    }
    const parts = obj(raw);
    const first = usageOfRawResponse(parts?.truncated);
    const last = usageOfRawResponse(parts?.final);
    if (first === undefined || last === undefined) continue;
    const sum: Usage = {
      input: first.input + last.input,
      output: first.output + last.output,
      cached_input: first.cached_input + last.cached_input,
      reasoning: first.reasoning + last.reasoning,
    };
    if (sameUsage(r.usage, sum)) out.set(r.run_id, first);
  }
  return out;
}

/**
 * The successful-call variant for a print, or no variant when none of its models has a discarded call (nothing would differ, so there is nothing to publish beside the headline).
 * `records` are every run record the print prices, a carried-forward row's included, and `dirs` where their raw files are.
 */
export async function successfulCallVariants(
  records: readonly RunRecord[],
  dirs: readonly string[],
  modelIds: readonly string[],
): Promise<PolicyVariant[]> {
  const ids = new Set(modelIds);
  const mine = records.filter((r) => ids.has(r.model_id));
  const discarded = await loadDiscardedFirstCalls(mine, dirs);
  const appliesTo = [...new Set(mine.filter((r) => discarded.has(r.run_id)).map((r) => r.model_id))];
  return appliesTo.length === 0 ? [] : [successfulCallVariant({ discarded, appliesTo })];
}
