/**
 * Fetches directly from chat-server's own GET /digest — deliberately NOT routed through this
 * app's `api.ts`/`getJson` pattern, which calls the console's own same-origin `/api` backend.
 * That backend is a local Node/Express process, 127.0.0.1-only by design (docs/console.md) —
 * it has no remote deployment and can't proxy this. chat-server is a real Cloudflare Worker with
 * its own CORS allowlist that already includes this console's own origin (see
 * packages/chat-server/src/workers/index.ts's ALLOWED_ORIGINS), so a direct cross-origin fetch
 * is the correct shape here, not a gap to work around.
 */
const CHAT_SERVER_URL = "https://chat.touchstoneassay.com";

export interface ChatDigestResponse {
  latest_weekly_digest: {
    week_start: string;
    common_questions: string[];
    unmet_asks: string[];
    declined_paid_calls: number;
    unanswered_conversations: number;
    generated_at: string;
  } | null;
  today: { conversations: number; messages: number; spent_usd: string };
}

export async function fetchChatDigest(): Promise<ChatDigestResponse> {
  const res = await fetch(`${CHAT_SERVER_URL}/digest`);
  if (!res.ok) throw new Error(`chat-server /digest returned ${res.status}`);
  return (await res.json()) as ChatDigestResponse;
}
