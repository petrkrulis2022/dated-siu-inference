/**
 * Does every provider this run needs actually answer, right now?
 *
 * Two runs in two days died mid-flight on an exhausted provider — Google on 2026-09-30 with a
 * `402`, Anthropic on 2026-10-01 with a `400` whose body read *"Your credit balance is too
 * low"*. Both had been topped up shortly beforehand, and in both cases the balance looked fine
 * on a dashboard. A dashboard is not a pre-flight check: it reports an organization's balance,
 * while a run spends through a key, and the two can belong to different organizations.
 *
 * **No provider exposes a credit balance programmatically.** Checked 2026-10-01: OpenAI's
 * `/v1/dashboard/billing/credit_grants` refuses anything but a browser session key, and xAI and
 * Anthropic have no balance endpoint at all. So this cannot print "$12.40 remaining", and
 * pretending otherwise would be worse than not trying.
 *
 * What it can do is the check that actually matters, which a balance would only approximate: a
 * real, minimal call through the same adapter the run uses, exercising key, organization and
 * balance together. An exhausted account fails it. A key pointing at the wrong organization
 * fails it. A revoked key fails it.
 *
 * And where a provider will say WHICH account it is, that is reported too — Anthropic's
 * `/v1/organizations/me` names the organization, which is precisely the fact that was missing
 * when a dashboard showed credit and the key reported none.
 */
import type { Adapter } from "@touchstone/harness";

export interface ProviderCheck {
  provider: string;
  model: string;
  ok: boolean;
  /** Who the key says it is, where the provider will say. */
  identity?: string;
  detail?: string;
  latencyMs?: number;
}

/** The cheapest call that still proves the whole path works: a few tokens in, one token out. */
const PROBE_PROMPT = "Reply with exactly: ok";

async function identityOf(provider: string): Promise<string | undefined> {
  try {
    if (provider === "anthropic") {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return undefined;
      const r = await fetch("https://api.anthropic.com/v1/organizations/me", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!r.ok) return undefined;
      const body = (await r.json()) as { name?: string };
      return body.name ? `org "${body.name}"` : undefined;
    }
    if (provider === "xai") {
      const key = process.env.XAI_API_KEY;
      if (!key) return undefined;
      const r = await fetch("https://api.x.ai/v1/api-key", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) return undefined;
      const body = (await r.json()) as { name?: string };
      return body.name ? `key "${body.name}"` : undefined;
    }
  } catch {
    // Identity is a nicety; failing to get it must never fail the check that matters.
  }
  return undefined;
}

/**
 * Probe one model per provider. Returns results rather than throwing, so the caller decides
 * whether an unreachable provider is fatal — which depends on what that provider is for.
 */
export async function checkProviders(
  byProvider: ReadonlyMap<string, { model: string; adapter: Adapter }>,
): Promise<ProviderCheck[]> {
  const out: ProviderCheck[] = [];
  for (const [provider, { model, adapter }] of byProvider) {
    const started = Date.now();
    try {
      await adapter(model, PROBE_PROMPT, { max_tokens: 16, temperature: 0 });
      out.push({
        provider,
        model,
        ok: true,
        latencyMs: Date.now() - started,
        ...((await identityOf(provider)) !== undefined
          ? { identity: (await identityOf(provider)) as string }
          : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
      const id = await identityOf(provider);
      out.push({
        provider,
        model,
        ok: false,
        detail,
        ...(id !== undefined ? { identity: id } : {}),
      });
    }
  }
  return out;
}

/** Human-readable, and explicit that a balance is not available rather than silently absent. */
export function renderProviderChecks(checks: readonly ProviderCheck[]): string {
  const lines = ["=== PROVIDER PRE-FLIGHT ==="];
  for (const c of checks) {
    const who = c.identity ? `  ${c.identity}` : "";
    lines.push(
      c.ok
        ? `  OK      ${c.provider.padEnd(10)} ${c.model} answered in ${c.latencyMs}ms${who}`
        : `  FAILED  ${c.provider.padEnd(10)} ${c.model}${who} — ${c.detail}`,
    );
  }
  lines.push(
    "  No provider exposes a credit balance to an API key (checked 2026-10-01), so this is a " +
      "live call\n  through the run's own adapter rather than a balance figure — it fails on an " +
      "exhausted account,\n  a revoked key, or a key billing to a different organization than the " +
      "one that was topped up.",
  );
  return lines.join("\n");
}
