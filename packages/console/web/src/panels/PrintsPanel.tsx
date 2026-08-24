import { useEffect, useState } from "react";
import { api, type ConfigResponse, type PrintDetailResponse, type PrintRow } from "../lib/api.js";
import { ExplorerLink } from "../components/ExplorerLink.js";

function VerificationBadge({ v }: { v: PrintRow["verification"] }): React.JSX.Element {
  if (v.error) {
    return (
      <span className="badge warn" title={v.error}>
        chain read failed
      </span>
    );
  }
  return v.verified ? (
    <span className="badge ok">verified</span>
  ) : (
    <span
      className="badge bad"
      title="Schema, self-signature, on-chain publisher match, and anchor must all pass."
    >
      not verified
    </span>
  );
}

export function PrintsPanel({ config }: { config: ConfigResponse | null }): React.JSX.Element {
  const [prints, setPrints] = useState<PrintRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PrintDetailResponse | null>(null);

  useEffect(() => {
    api
      .prints()
      .then(setPrints)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    api
      .print(selected)
      .then(setDetail)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [selected]);

  return (
    <div className="panel">
      <h2>Prints</h2>
      {config && (
        <p className="muted">
          Spend ceiling:{" "}
          {config.spendCeilingUsd ? `$${config.spendCeilingUsd}` : "not yet set by an automated run"}{" "}
          · configured via the <code>PUBLISH_SPEND_CEILING_USD</code> GitHub Actions repository
          variable, not editable here.
        </p>
      )}
      {error && <p className="bad">{error}</p>}
      {prints && prints.length === 0 && <p className="empty">No prints published yet.</p>}
      {prints && prints.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Status</th>
              <th>Dated SIU</th>
              <th>Weights</th>
              <th>Methodology</th>
              <th>Cost</th>
              <th>Anchor</th>
              <th>Signature</th>
            </tr>
          </thead>
          <tbody>
            {prints.map((p) => (
              <tr
                key={p.print_id}
                onClick={() => setSelected(p.print_id)}
                style={{ cursor: "pointer" }}
              >
                <td>{p.date}</td>
                <td>{p.status}</td>
                <td>{p.dated_siu}</td>
                <td>{p.weights_source}</td>
                <td>{p.methodology_version}</td>
                <td>${p.cost_of_production_usd}</td>
                <td>
                  {p.anchor_tx_hash ? (
                    <ExplorerLink config={config} kind="tx" value={p.anchor_tx_hash} />
                  ) : (
                    <span className="muted">{p.anchor_status}</span>
                  )}
                </td>
                <td>
                  <VerificationBadge v={p.verification} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail && <PrintDetail detail={detail} />}
    </div>
  );
}

interface ExchangeRateRow {
  model_id: string;
  usd_per_siu?: string;
  spread_to_index?: string;
  siu_per_usd?: string;
  excluded_reason?: string;
}
interface SensitivityRow {
  policy_variant: string;
  dated_siu: string;
  delta: string;
  applies_to?: string[];
}
interface PrintFields {
  print_id: string;
  cost_of_production_usd: string;
  floor?: { value: string; notes?: string };
  market_spread?: string;
  exchange_rate_table: ExchangeRateRow[];
  sensitivity_block: SensitivityRow[];
}

function PrintDetail({ detail }: { detail: PrintDetailResponse }): React.JSX.Element {
  const print = detail.print as unknown as PrintFields;
  return (
    <div style={{ marginTop: 16, borderTop: "1px solid #262b38", paddingTop: 16 }}>
      <h3>{print.print_id}</h3>

      <div className="stat-row">
        <div className="stat">
          <div className="value">${print.cost_of_production_usd}</div>
          <div className="label">Cost of production</div>
        </div>
        <div className="stat">
          <div className="value">{print.floor ? `$${print.floor.value}` : "—"}</div>
          <div className="label">Floor (open-weight substitution)</div>
        </div>
        <div className="stat">
          <div className="value">{print.market_spread ?? "—"}</div>
          <div className="label">Market spread (print ÷ floor)</div>
        </div>
      </div>
      {print.floor?.notes && <p className="muted">{print.floor.notes}</p>}
      {!print.floor && (
        <p className="muted">No floor measurement exists for this print — absent, not zero.</p>
      )}

      <h4>Exchange rate table</h4>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>USD/SIU</th>
            <th>Spread</th>
            <th>SIU/$1</th>
            <th>Excluded</th>
          </tr>
        </thead>
        <tbody>
          {print.exchange_rate_table.map((row) => (
            <tr key={row.model_id}>
              <td>{row.model_id}</td>
              <td>{row.usd_per_siu ?? "—"}</td>
              <td>{row.spread_to_index ?? "—"}</td>
              <td>{row.siu_per_usd ?? "—"}</td>
              <td className={row.excluded_reason ? "warn" : "muted"}>
                {row.excluded_reason ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Sensitivity block</h4>
      <table>
        <thead>
          <tr>
            <th>Policy variant</th>
            <th>Dated SIU</th>
            <th>Delta</th>
            <th>Applies to</th>
          </tr>
        </thead>
        <tbody>
          {print.sensitivity_block.map((row) => (
            <tr key={row.policy_variant}>
              <td>{row.policy_variant}</td>
              <td>{row.dated_siu}</td>
              <td>{row.delta}</td>
              <td className="muted">{(row.applies_to ?? []).join(", ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted">
        Raw runs: <code>data/runs/{print.print_id}/</code>
      </p>

      <details>
        <summary className="muted">Raw print JSON</summary>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            fontSize: 12,
            background: "#0b0e14",
            padding: 12,
            borderRadius: 6,
            maxHeight: 480,
            overflow: "auto",
          }}
        >
          {JSON.stringify(detail.print, null, 2)}
        </pre>
      </details>
    </div>
  );
}
