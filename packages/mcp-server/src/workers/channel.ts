/**
 * Which listing brought a call: the `?via=` tag on the server's URL. Each listing gets its own link
 * (the registry `…/mcp?via=registry`, mcprush `…/mcp?via=mcprush`, Circle's marketplace
 * `…/v1/quote?via=circle`, …), and every usage event and every paid call's settlement-log row
 * carries the channel, so the payment log shows which listing brings agents that pay.
 *
 * Only tags in CHANNELS are kept; anything else is "other" and no tag is "direct", so the data
 * holds a short fixed vocabulary and nobody can write arbitrary text into it. The tag names a
 * public listing, never a person.
 */
export const CHANNELS = [
  "registry",
  "glama",
  "mcprush",
  "circle",
  "smithery",
  "pulsemcp",
  "mcpso",
  "x402scan",
  "site",
] as const;

export type Channel = (typeof CHANNELS)[number] | "direct" | "other";

const KNOWN: ReadonlySet<string> = new Set(CHANNELS);

/** The channel of a request, from its URL; a session's remembered tag stands in when the URL has none. */
export function channelFrom(url: string, sessionTag?: string): Channel {
  let raw: string | null;
  try {
    raw = new URL(url).searchParams.get("via");
  } catch {
    raw = null;
  }
  const tag = (raw ?? "").trim().toLowerCase();
  if (tag === "") return sessionTag && KNOWN.has(sessionTag) ? (sessionTag as Channel) : "direct";
  return KNOWN.has(tag) ? (tag as Channel) : "other";
}

interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

const SESSION_TTL_S = 7 * 24 * 60 * 60;

async function sessionKey(sessionId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `via-session:${hex.slice(0, 32)}`;
}

/**
 * Remembers a tagged MCP session's channel for a week, in case the client drops the query string on
 * later requests. Untagged sessions store nothing. Never throws: tracking must not break a call.
 */
export async function rememberSessionChannel(kv: KvLike | undefined, sessionId: string | undefined, channel: Channel): Promise<void> {
  if (!kv || !sessionId || channel === "direct") return;
  try {
    await kv.put(await sessionKey(sessionId), channel, { expirationTtl: SESSION_TTL_S });
  } catch {
    // tracking is best effort
  }
}

/** The channel remembered for an MCP session, if any. Never throws. */
export async function sessionChannel(kv: KvLike | undefined, sessionId: string | undefined): Promise<string | undefined> {
  if (!kv || !sessionId) return undefined;
  try {
    return (await kv.get(await sessionKey(sessionId))) ?? undefined;
  } catch {
    return undefined;
  }
}
