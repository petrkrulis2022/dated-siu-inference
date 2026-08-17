import { useEffect, useState } from "react";
import { api, type ActivityResponse, type ConfigResponse } from "../lib/api.js";
import { ExplorerLink } from "../components/ExplorerLink.js";

function statusBadge(status: "open" | "settled" | "expired"): React.JSX.Element {
  const cls = status === "settled" ? "ok" : status === "expired" ? "warn" : "muted";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function ActivityPanel({ config }: { config: ConfigResponse | null }): React.JSX.Element {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .activity()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <div className="panel">
      <h2>Agent activity</h2>
      <p className="muted">
        Reconstructed entirely from <code>DatumEscrow</code>'s on-chain <code>Opened</code>/
        <code>Settled</code>/<code>Expired</code> events. Run <code>pnpm console:index</code> to
        refresh from live chain.
      </p>
      {error && <p className="bad">{error}</p>}
      {data && (
        <div className="stat-row">
          <div className="stat">
            <div className="value">{data.aggregates.totalUsdcSettledMinorUnits}</div>
            <div className="label">Total USDC settled (minor units)</div>
          </div>
          <div className="stat">
            <div className="value">{data.aggregates.totalSiuTransacted}</div>
            <div className="label">Total SIU transacted (known quotes only)</div>
          </div>
          <div className="stat">
            <div className="value">{Object.keys(data.aggregates.bySeller).length}</div>
            <div className="label">Distinct sellers</div>
          </div>
          <div className="stat">
            <div className="value">{Object.keys(data.aggregates.byBuyer).length}</div>
            <div className="label">Distinct buyers</div>
          </div>
        </div>
      )}
      {data && data.lifecycles.length === 0 && (
        <p className="empty">No escrow activity indexed yet — run `pnpm console:index`.</p>
      )}
      {data && data.lifecycles.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Quote hash</th>
              <th>Buyer</th>
              <th>Seller</th>
              <th>Max amount</th>
              <th>Actual</th>
              <th>Fee</th>
              <th>Refund</th>
              <th>Quote (SIU / model / print)</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {data.lifecycles.map((l) => (
              <tr key={l.quoteHash}>
                <td>{statusBadge(l.status)}</td>
                <td>
                  <ExplorerLink
                    config={config}
                    kind="tx"
                    value={l.openedTx}
                    label={l.quoteHash.slice(0, 10) + "…"}
                  />
                </td>
                <td>
                  <ExplorerLink config={config} kind="address" value={l.buyer} />
                </td>
                <td>
                  <ExplorerLink config={config} kind="address" value={l.seller} />
                </td>
                <td>{l.maxAmount}</td>
                <td>{l.actualAmount ?? "—"}</td>
                <td>{l.feeAmount ?? "—"}</td>
                <td>{l.buyerRefund ?? "—"}</td>
                <td className={l.quote ? "" : "muted"}>
                  {l.quote
                    ? `${l.quote.siu} SIU / ${l.quote.model} / ${l.quote.printId}`
                    : "quote unknown"}
                </td>
                <td>{l.openedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
