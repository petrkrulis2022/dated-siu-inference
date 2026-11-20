import { Decimal } from "decimal.js";

/** What a provider's own response says about how a call was bought: the service tier that served it, and, where the response reports one, the amount
 * billed for it in USD. */
export interface ResponseBilling {
  /** Copied verbatim from the response; null when it names none. */
  service_tier: string | null;
  /** A decimal string, present only when the response reports a billed figure (OpenRouter's usage.cost, xAI's usage.cost_in_usd_ticks). */
  billed_usd?: string;
}

/** xAI bills in ticks of 1e-10 USD (confirmed against every grok-4.6 call on 2026-11-20: ticks x 1e-10 equals the call's tokens at the list price
 * exactly). */
const XAI_TICKS_PER_USD = new Decimal("1e10");

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function tierOf(response: Record<string, unknown>): string | null {
  const candidates = [response.service_tier, record(response.usage)?.service_tier, record(response.usageMetadata)?.serviceTier];
  const tier = candidates.find((t) => typeof t === "string" && t.length > 0);
  return (tier as string | undefined) ?? null;
}

/**
 * The billed figure of one response, or undefined when it reports none we can read. A number is turned into a decimal string through its own
 * shortest representation (what the provider's JSON said), never through float arithmetic; anything that is not a finite, non-negative number is
 * left out rather than guessed, so the call falls back to its tier's list price and the price check reports the gap.
 */
function billedOf(response: Record<string, unknown>): Decimal | undefined {
  const usage = record(response.usage);
  if (usage === undefined) return undefined;
  const cost = usage.cost;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) return new Decimal(String(cost));
  const ticks = usage.cost_in_usd_ticks;
  if (typeof ticks === "number" && Number.isSafeInteger(ticks) && ticks >= 0) return new Decimal(ticks).dividedBy(XAI_TICKS_PER_USD);
  return undefined;
}

/**
 * The service tier and billed cost a provider's raw response reports (docs/methodology.md, rules-2026-11-20: a constituent's price is what was billed;
 * the tier is part of its purchase path). Reads the shapes the adapters store: OpenAI-shaped responses (OpenRouter, xAI, OpenAI: top-level
 * service_tier), Anthropic's usage.service_tier, Google's usageMetadata.serviceTier, and the `{ truncated, final }` wrapper an adapter stores when a
 * reasoning-truncated call was retried (both calls were billed, so both billed figures count; the tier is the final call's). Used by the harness
 * for every new run record, and by the print for records written before these fields existed, from the same stored raw response.
 */
export function billingFromRaw(raw: unknown): ResponseBilling {
  const top = record(raw);
  if (top === undefined) return { service_tier: null };
  const wrapped = record(top.final);
  const calls = wrapped ? [record(top.truncated), wrapped].filter((c): c is Record<string, unknown> => c !== undefined) : [top];
  const last = calls[calls.length - 1] as Record<string, unknown>;

  const billed = calls.map(billedOf);
  const service_tier = tierOf(last);
  // Billed only when every billed call in the response reports a figure: half a sum would understate the call.
  if (billed.some((b) => b === undefined)) return { service_tier };
  const total = (billed as Decimal[]).reduce((acc, b) => acc.plus(b), new Decimal(0));
  return { service_tier, billed_usd: total.toFixed() };
}
