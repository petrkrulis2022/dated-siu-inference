import { useEffect, useState } from "react";
import { fetchChatDigest, type ChatDigestResponse } from "../lib/chat-digest.js";

/**
 * Read-only view into the chat widget's own analysis layer — no session content ever reaches
 * this panel, only aggregates (chat-server's GET /digest never returns transcripts). Matches
 * every other panel's read-only, no-write-capable-import discipline; this one additionally never
 * imports anything wallet- or chain-related, since it has nothing to do with settlement.
 */
export function ChatAnalyticsPanel(): React.JSX.Element {
  const [data, setData] = useState<ChatDigestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchChatDigest()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const digest = data?.latest_weekly_digest ?? null;

  return (
    <div className="panel">
      <h2>Chat analytics</h2>
      {error && <p className="bad">{error}</p>}

      {data && (
        <div className="stat-row">
          <div className="stat">
            <div className="value">{data.today.conversations}</div>
            <div className="label">Conversations today</div>
          </div>
          <div className="stat">
            <div className="value">{data.today.messages}</div>
            <div className="label">Messages today</div>
          </div>
          <div className="stat">
            <div className="value">${data.today.spent_usd}</div>
            <div className="label">Spent today (of the daily cap)</div>
          </div>
        </div>
      )}

      {data && !digest && (
        <p className="empty">
          No weekly digest yet — the first one generates Sunday 02:00 UTC, once the widget has a
          week of real conversations behind it.
        </p>
      )}

      {digest && (
        <>
          <p className="muted">
            Week of {digest.week_start} · generated {digest.generated_at}
          </p>

          <div className="stat-row">
            <div className="stat">
              <div className={`value ${digest.declined_paid_calls > 0 ? "bad" : "ok"}`}>
                {digest.declined_paid_calls}
              </div>
              <div className="label">Quotes offered, no paid call followed</div>
            </div>
            <div className="stat">
              <div className={`value ${digest.unanswered_conversations > 0 ? "bad" : "ok"}`}>
                {digest.unanswered_conversations}
              </div>
              <div className="label">Conversations ended without an answer</div>
            </div>
          </div>

          <h3>Common questions this week</h3>
          {digest.common_questions.length === 0 ? (
            <p className="empty">None clustered — too few conversations, or the clustering step didn't run.</p>
          ) : (
            <ul>
              {digest.common_questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          )}

          <h3>Asked for, not offered</h3>
          {digest.unmet_asks.length === 0 ? (
            <p className="empty">
              None this week — matched against a fixed list (provider credits, a compute
              marketplace, a token).
            </p>
          ) : (
            <ul>
              {digest.unmet_asks.map((a) => (
                <li key={a} className="bad">
                  {a}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
