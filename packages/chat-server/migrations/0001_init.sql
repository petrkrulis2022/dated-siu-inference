-- The chat widget's analysis layer — design-doc-approved schema
-- (/home/petrunix/.claude/plans/wiggly-floating-yeti.md's Phase D). The research value is the
-- reason this widget exists, not an afterthought: every column here answers a question the
-- weekly digest or the console's ChatAnalyticsPanel actually reads back out.

CREATE TABLE conversations (
  session_id TEXT PRIMARY KEY,
  -- 'human' | 'agent' | 'unknown' — a heuristic (user-agent shape, whether /mcp.json was
  -- fetched first, request shape), never treated as a strong signal anywhere it's read.
  visitor_type TEXT NOT NULL DEFAULT 'unknown',
  -- Hashed, never the raw IP — see src/pii.ts.
  ip_hash TEXT,
  started_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  quote_offered INTEGER NOT NULL DEFAULT 0,
  -- Best-effort join against mcp-server's own Analytics Engine payer-address data by timing
  -- proximity — never a hard link, since this database has no way to know a payer's wallet
  -- address belongs to the same visitor as a given chat session.
  paid_call_followed INTEGER NOT NULL DEFAULT 0,
  -- Set by the weekly digest job, not live — see src/digest.ts. A session counts as "ended
  -- without an answer" once its last message was from the visitor and 30+ minutes have passed
  -- with no reply.
  ended_without_answer INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES conversations(session_id),
  role TEXT NOT NULL, -- 'user' | 'assistant'
  -- Stripped: API-key-shaped strings and email addresses regex-redacted (src/pii.ts) before
  -- this row is ever written — never stored even transiently.
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_session_id ON messages(session_id);

CREATE TABLE weekly_digests (
  week_start TEXT PRIMARY KEY, -- ISO date, Monday of the digested week
  common_questions TEXT NOT NULL, -- JSON array of strings
  unmet_asks TEXT NOT NULL, -- JSON array of strings — asked for, not offered
  declined_paid_calls INTEGER NOT NULL, -- quote_offered=1, paid_call_followed=0
  unanswered_conversations INTEGER NOT NULL,
  generated_at TEXT NOT NULL
);
