/**
 * D1 query helpers — the analysis layer's storage, designed in from the schema up (see
 * migrations/0001_init.sql). Every write here happens only after a message's content has already
 * had stripSensitive applied by the caller (workers/index.ts) for the visitor's own text; this
 * file has no PII-handling logic of its own, only SQL.
 */

export interface ConversationRow {
  session_id: string;
  visitor_type: string;
  ip_hash: string | null;
  started_at: string;
  last_message_at: string;
  message_count: number;
  quote_offered: number;
  paid_call_followed: number;
  ended_without_answer: number;
}

export interface MessageRow {
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export async function getConversation(db: D1Database, sessionId: string): Promise<ConversationRow | null> {
  const row = await db
    .prepare("SELECT * FROM conversations WHERE session_id = ?")
    .bind(sessionId)
    .first<ConversationRow>();
  return row ?? null;
}

/** Creates the conversation row on a session's first message; otherwise a no-op — the message
 * count and last_message_at are advanced separately by touchConversation, after the reply. */
export async function ensureConversation(
  db: D1Database,
  sessionId: string,
  visitorType: string,
  ipHash: string,
  nowIso: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO conversations (session_id, visitor_type, ip_hash, started_at, last_message_at, message_count, quote_offered, paid_call_followed, ended_without_answer)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)
       ON CONFLICT(session_id) DO NOTHING`,
    )
    .bind(sessionId, visitorType, ipHash, nowIso, nowIso)
    .run();
}

export async function recordMessage(
  db: D1Database,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  nowIso: string,
): Promise<void> {
  await db
    .prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    .bind(sessionId, role, content, nowIso)
    .run();
}

export async function touchConversation(
  db: D1Database,
  sessionId: string,
  opts: { lastMessageAt: string; quoteOffered?: boolean },
): Promise<void> {
  if (opts.quoteOffered) {
    await db
      .prepare(
        "UPDATE conversations SET last_message_at = ?, message_count = message_count + 1, quote_offered = 1 WHERE session_id = ?",
      )
      .bind(opts.lastMessageAt, sessionId)
      .run();
  } else {
    await db
      .prepare("UPDATE conversations SET last_message_at = ?, message_count = message_count + 1 WHERE session_id = ?")
      .bind(opts.lastMessageAt, sessionId)
      .run();
  }
}

/** Chronological order (oldest first) — the shape the Anthropic Messages API expects. */
export async function getRecentMessages(db: D1Database, sessionId: string, limit: number): Promise<MessageRow[]> {
  const { results } = await db
    .prepare("SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?")
    .bind(sessionId, limit)
    .all<MessageRow>();
  return results.reverse();
}

export async function getTodayCounts(
  db: D1Database,
  todayStartIso: string,
): Promise<{ conversations: number; messages: number }> {
  const convRow = await db
    .prepare("SELECT COUNT(*) as n FROM conversations WHERE last_message_at >= ?")
    .bind(todayStartIso)
    .first<{ n: number }>();
  const msgRow = await db
    .prepare("SELECT COUNT(*) as n FROM messages WHERE created_at >= ?")
    .bind(todayStartIso)
    .first<{ n: number }>();
  return { conversations: convRow?.n ?? 0, messages: msgRow?.n ?? 0 };
}

export interface WeeklyDigestRow {
  week_start: string;
  common_questions: string;
  unmet_asks: string;
  declined_paid_calls: number;
  unanswered_conversations: number;
  generated_at: string;
}

export async function getLatestWeeklyDigest(db: D1Database): Promise<WeeklyDigestRow | null> {
  const row = await db
    .prepare("SELECT * FROM weekly_digests ORDER BY week_start DESC LIMIT 1")
    .first<WeeklyDigestRow>();
  return row ?? null;
}

export async function insertWeeklyDigest(db: D1Database, row: WeeklyDigestRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO weekly_digests (week_start, common_questions, unmet_asks, declined_paid_calls, unanswered_conversations, generated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(week_start) DO UPDATE SET
         common_questions = excluded.common_questions,
         unmet_asks = excluded.unmet_asks,
         declined_paid_calls = excluded.declined_paid_calls,
         unanswered_conversations = excluded.unanswered_conversations,
         generated_at = excluded.generated_at`,
    )
    .bind(
      row.week_start,
      row.common_questions,
      row.unmet_asks,
      row.declined_paid_calls,
      row.unanswered_conversations,
      row.generated_at,
    )
    .run();
}

/** The user-visible text of every message sent in [weekStartIso, weekEndIso) — used only as
 * input to the weekly digest's clustering step, never returned from any endpoint verbatim. */
export async function getWeekUserMessages(
  db: D1Database,
  weekStartIso: string,
  weekEndIso: string,
): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT content FROM messages WHERE role = 'user' AND created_at >= ? AND created_at < ?")
    .bind(weekStartIso, weekEndIso)
    .all<{ content: string }>();
  return results.map((r) => r.content);
}

export async function countDeclinedPaidCalls(db: D1Database, weekStartIso: string, weekEndIso: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) as n FROM conversations WHERE quote_offered = 1 AND paid_call_followed = 0 AND last_message_at >= ? AND last_message_at < ?",
    )
    .bind(weekStartIso, weekEndIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Marks conversations whose last message was from the visitor and is now stale as "ended
 * without an answer" — run from the weekly digest job (see workers/index.ts's scheduled
 * handler), per the brief's own placement of this logic there rather than per-request. */
export async function markStaleConversationsUnanswered(db: D1Database, staleBeforeIso: string): Promise<void> {
  await db
    .prepare(
      `UPDATE conversations
       SET ended_without_answer = 1
       WHERE ended_without_answer = 0
         AND last_message_at < ?
         AND (SELECT role FROM messages WHERE messages.session_id = conversations.session_id ORDER BY id DESC LIMIT 1) = 'user'`,
    )
    .bind(staleBeforeIso)
    .run();
}

export async function countUnansweredInWeek(db: D1Database, weekStartIso: string, weekEndIso: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) as n FROM conversations WHERE ended_without_answer = 1 AND last_message_at >= ? AND last_message_at < ?",
    )
    .bind(weekStartIso, weekEndIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 90-day retention for raw transcripts — weekly_digests rows are never touched, by design (no
 * per-visitor content in a digest to retain or delete). */
export async function deleteOldConversations(db: D1Database, cutoffIso: string): Promise<void> {
  await db
    .prepare("DELETE FROM messages WHERE session_id IN (SELECT session_id FROM conversations WHERE last_message_at < ?)")
    .bind(cutoffIso)
    .run();
  await db.prepare("DELETE FROM conversations WHERE last_message_at < ?").bind(cutoffIso).run();
}
