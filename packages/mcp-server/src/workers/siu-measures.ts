import type { AnalyticsEngineDataset } from "@cloudflare/workers-types";

/**
 * The measures behind the SIU price in 402s (owner's approval, 2026-11-26), written to the same
 * Analytics Engine dataset as the usage counts (./analytics.ts):
 *
 * - coverage: every 402 a paid tool sends, and whether it carried an SIU price ("siu") or the USDC
 *   amounts only ("usdc-only"). Near 100% by construction: it measures this server, not agents.
 * - behaviour: an MCP session that saw a 402 and later paid. Both rows carry the same session tag,
 *   a one-way hash of the MCP session id, so the two can be matched without storing the id itself.
 *   REST calls have no session, so they count toward coverage only. The other behaviour measure,
 *   paid get_quote and convert calls on mainnet, comes from the settlement log (./settlement-log.ts).
 *
 * As with the usage counts: no request bodies, no IP addresses, and nothing here can fail a call.
 */

interface UsageEnv {
  USAGE: AnalyticsEngineDataset;
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

/** First 16 hex characters of SHA-256 of the MCP session id; empty when there is no session. */
export async function sessionTag(sessionId: string | undefined): Promise<string> {
  if (!sessionId) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function write(env: UsageEnv, ctx: Ctx, sessionId: string | undefined, point: (tag: string) => unknown) {
  ctx.waitUntil(
    sessionTag(sessionId)
      .then((tag) => env.USAGE.writeDataPoint(point(tag) as Parameters<AnalyticsEngineDataset["writeDataPoint"]>[0]))
      .catch((err) => console.error("SIU measure logging failed:", err)),
  );
}

/** One 402 sent by a paid tool. */
export function recordChallenge(
  env: UsageEnv,
  ctx: Ctx,
  tool: string,
  profile: string,
  siuPriced: boolean,
  sessionId: string | undefined,
): void {
  write(env, ctx, sessionId, (tag) => ({
    blobs: ["challenge", tool, profile, siuPriced ? "siu" : "usdc-only", tag],
    doubles: [1],
    indexes: ["challenge"],
  }));
}

/** One paid call made inside an MCP session; nothing is written without a session. */
export function recordPaidInSession(
  env: UsageEnv,
  ctx: Ctx,
  tool: string,
  profile: string,
  sessionId: string | undefined,
): void {
  if (!sessionId) return;
  write(env, ctx, sessionId, (tag) => ({
    blobs: ["paid", tool, profile, "", tag],
    doubles: [1],
    indexes: ["paid"],
  }));
}
