import { useEffect, useState } from "react";
import { api, type ConfigResponse, type QuotedVsPaidResponse } from "../lib/api.js";
import { ExplorerLink } from "../components/ExplorerLink.js";

/**
 * The honest-seller check, visible at a glance across all activity — the thing `verify_receipt`
 * exists to prove. A mismatched row (a seller settling for more than it quoted) renders in red
 * and sorts to the top; this is deliberately the most visually blunt panel in the console.
 */
export function QuotedVsPaidPanel({
  config,
}: {
  config: ConfigResponse | null;
}): React.JSX.Element {
  const [data, setData] = useState<QuotedVsPaidResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .quotedVsPaid()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const rows = data ? [...data.rows].sort((a, b) => Number(a.matched) - Number(b.matched)) : [];
  const mismatchCount = rows.filter((r) => !r.matched).length;

  return (
    <div className="panel">
      <h2>Quoted vs paid</h2>
      {error && <p className="bad">{error}</p>}
      {data && (
        <div className="stat-row">
          <div className="stat">
            <div className={`value ${mismatchCount > 0 ? "bad" : "ok"}`}>{mismatchCount}</div>
            <div className="label">Mismatches</div>
          </div>
          <div className="stat">
            <div className="value">{rows.length}</div>
            <div className="label">Settlements with a known quote</div>
          </div>
          <div className="stat">
            <div className="value muted">{data.unknownQuoteCount}</div>
            <div className="label">Settlements with quote unknown</div>
          </div>
        </div>
      )}
      {data && rows.length === 0 && (
        <p className="empty">
          No settlements with a locally-known quote yet. Sellers log quotes to{" "}
          <code>data/.cache/quotes/</code> when they issue them — run the demo agents, then
          re-index.
        </p>
      )}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Result</th>
              <th>Quoted (ceiling)</th>
              <th>Paid</th>
              <th>Seller</th>
              <th>Buyer</th>
              <th>Settled</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.quoteHash}
                style={!r.matched ? { background: "rgba(255,107,107,0.12)" } : undefined}
              >
                <td className={r.matched ? "ok" : "bad"}>{r.matched ? "matched" : "MISMATCH"}</td>
                <td>${r.amountQuotedUsd}</td>
                <td className={r.matched ? "" : "bad"}>${r.amountPaidUsd}</td>
                <td>
                  <ExplorerLink config={config} kind="address" value={r.seller} />
                </td>
                <td>
                  <ExplorerLink config={config} kind="address" value={r.buyer} />
                </td>
                <td>
                  <ExplorerLink config={config} kind="tx" value={r.settledTx} label={r.settledAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
