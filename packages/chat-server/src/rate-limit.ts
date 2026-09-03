import { Decimal } from "decimal.js";

/**
 * Two of the three abuse/cost controls (see chat-budget-tracker.ts for the third, the hard daily
 * $ cap). Both of these live in KV, deliberately: KV is only eventually consistent, which is
 * fine here — a session or IP squeaking a few extra requests past a soft limit under a race is
 * an acceptable cost, unlike the daily ceiling, which is why that one is a Durable Object instead.
 */

const SESSION_MAX_MESSAGES = 20;
const SESSION_MAX_SPEND_USD = "0.05";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // a week — well past this widget's own 90-day retention isn't needed; this is just abuse-window bookkeeping, not the record of the conversation itself (that's D1).

const IP_MAX_NEW_SESSIONS_PER_HOUR = 5;
const IP_WINDOW_TTL_SECONDS = 60 * 60;

interface SessionUsage {
  messageCount: number;
  spentUsd: string;
}

/** Checked before a session's message is processed. Read-only — call bumpSessionUsage after the
 * real cost of the turn is known, not before, so a refused turn never counts against the cap. */
export async function checkSessionCap(
  kv: KVNamespace,
  sessionId: string,
): Promise<{ allowed: boolean }> {
  const stored = await kv.get<SessionUsage>(`session:${sessionId}`, "json");
  if (!stored) return { allowed: true };
  if (stored.messageCount >= SESSION_MAX_MESSAGES) return { allowed: false };
  if (new Decimal(stored.spentUsd).greaterThanOrEqualTo(SESSION_MAX_SPEND_USD)) return { allowed: false };
  return { allowed: true };
}

export async function bumpSessionUsage(kv: KVNamespace, sessionId: string, turnCostUsd: string): Promise<void> {
  const key = `session:${sessionId}`;
  const stored = await kv.get<SessionUsage>(key, "json");
  const next: SessionUsage = {
    messageCount: (stored?.messageCount ?? 0) + 1,
    spentUsd: new Decimal(stored?.spentUsd ?? 0).add(turnCostUsd).toString(),
  };
  await kv.put(key, JSON.stringify(next), { expirationTtl: SESSION_TTL_SECONDS });
}

/** Checked only when a request's session id has no existing conversation row — an established
 * session sending its 6th message isn't a "new session" and shouldn't count against this. */
export async function checkAndBumpIpNewSessionLimit(
  kv: KVNamespace,
  ipHash: string,
  now: Date,
): Promise<{ allowed: boolean }> {
  const hourBucket = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const key = `ip-new-sessions:${ipHash}:${hourBucket}`;
  const current = Number((await kv.get(key)) ?? "0");
  if (current >= IP_MAX_NEW_SESSIONS_PER_HOUR) return { allowed: false };
  await kv.put(key, String(current + 1), { expirationTtl: IP_WINDOW_TTL_SECONDS });
  return { allowed: true };
}

/** SHA-256 of the real client IP — the raw address is never stored anywhere (D1's `ip_hash`
 * column, this KV key). Uses Web Crypto, available in the Workers runtime with no dependency. */
export async function hashIp(ip: string): Promise<string> {
  const bytes = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
