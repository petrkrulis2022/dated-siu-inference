import { useEffect, useState } from "react";
import { api, type ConfigResponse, type HealthResponse } from "../lib/api.js";
import { ExplorerLink } from "../components/ExplorerLink.js";

function weiToEth(wei: string): string {
  const asNumber = Number(wei) / 1e18;
  return asNumber.toFixed(5);
}

export function HealthPanel({ config }: { config: ConfigResponse | null }): React.JSX.Element {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .health()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) return <div className="panel bad">{error}</div>;
  if (!data) return <div className="panel muted">Loading…</div>;

  const lowGas = Number(data.publisherEthBalanceWei) < 1e16; // < 0.01 ETH

  return (
    <div className="panel">
      <h2>Health</h2>

      <div className="stat-row">
        <div className="stat">
          <div className={`value ${lowGas ? "bad" : "ok"}`}>
            {weiToEth(data.publisherEthBalanceWei)} ETH
          </div>
          <div className="label">Publisher gas balance</div>
        </div>
        <div className="stat">
          <div className="value">{data.latestPrint?.print_id ?? "—"}</div>
          <div className="label">Latest print</div>
        </div>
      </div>

      <h3>Gate failures in latest print</h3>
      {data.gateFailuresInLatestPrint.length === 0 ? (
        <p className="empty">None.</p>
      ) : (
        <ul>
          {data.gateFailuresInLatestPrint.map((f, i) => (
            <li key={i} className="bad">
              {f.model_id}: {f.reason}
            </li>
          ))}
        </ul>
      )}

      <h3>Subsidised prices</h3>
      {data.subsidisedModels.length === 0 ? (
        <p className="empty">None flagged.</p>
      ) : (
        <ul>
          {data.subsidisedModels.map((m) => (
            <li key={m.model_id} className="warn">
              {m.model_id}: ${m.price_in_usd_per_1m}/${m.price_out_usd_per_1m} per 1M
            </li>
          ))}
        </ul>
      )}

      <h3>Price snapshot</h3>
      <p className={data.priceSnapshotIsStale ? "warn" : "ok"}>
        {data.priceSnapshotTimestamp
          ? `${data.priceSnapshotTimestamp}${data.priceSnapshotIsStale ? " — older than the latest print" : " — current"}`
          : "No price snapshot found."}
      </p>

      <h3>Unanchored prints</h3>
      {data.unanchoredPrints.length === 0 ? (
        <p className="empty">None.</p>
      ) : (
        <ul>
          {data.unanchoredPrints.map((p) => (
            <li key={p.print_id} className="bad">
              {p.print_id} ({p.date}) — {p.anchorStatus}
            </li>
          ))}
        </ul>
      )}

      <h3>Provisional past the reconciliation window</h3>
      {data.staleProvisionalPrints.length === 0 ? (
        <p className="empty">None.</p>
      ) : (
        <ul>
          {data.staleProvisionalPrints.map((p) => (
            <li key={p.print_id} className="warn">
              {p.print_id} — {p.daysSincePublished} days provisional
            </li>
          ))}
        </ul>
      )}

      {config && (
        <p className="muted">
          Publisher:{" "}
          <ExplorerLink
            config={config}
            kind="address"
            value={config.attestationAddress}
            label="TouchstoneAttestation"
          />
        </p>
      )}
    </div>
  );
}
