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
              <th>Corrections</th>
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
                <td>{p.final ? "final" : "provisional"}</td>
                <td>{p.dated_siu}</td>
                <td>{p.weights_source}</td>
                <td>{p.methodology_version}</td>
                <td>${p.cost_of_production_usd}</td>
                <td>
                  {p.correction_notes_count > 0 ? (
                    <span
                      className="badge warn"
                      title="This print has been corrected after publication — see its own correction notice below, or the public print page."
                    >
                      {p.correction_notes_count}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
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
interface CorrectionNote {
  published_at: string;
  note: string;
}
interface PrintFields {
  print_id: string;
  cost_of_production_usd: string;
  floor?: { value: string; notes?: string };
  market_spread?: string;
  exchange_rate_table: ExchangeRateRow[];
  sensitivity_block: SensitivityRow[];
  correction_notes?: CorrectionNote[];
}

function CorrectionNotices({ notes }: { notes: CorrectionNote[] }): React.JSX.Element | null {
  if (notes.length === 0) return null;
  // Same prominence as the public site's own renderCorrectionNotesNotice — docs/methodology.md's
  // revision policy: a fact disclosed after publication that doesn't change dated_siu. Rendered
  // first, before anything else about this print, not buried in the raw-JSON dump below — found
  // live, 2026-09-13: this console showed no correction notices at all, while the public site
  // rendered them prominently, making this the one view an operator could read without ever
  // seeing a disclosure that applied to the print in front of them.
  return (
    <div
      style={{
        marginBottom: 16,
        padding: 12,
        borderRadius: 6,
        border: "1px solid #7a5c00",
        background: "#2a2210",
      }}
    >
      <strong>Correction notice</strong> — published after this print, disclosing a fact that does
      not change dated_siu:
      <ul className="link-list">
        {notes.map((n, i) => (
          <li key={i}>
            {n.published_at} — {n.note}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PrintDetail({ detail }: { detail: PrintDetailResponse }): React.JSX.Element {
  const print = detail.print as unknown as PrintFields;
  return (
    <div style={{ marginTop: 16, borderTop: "1px solid #262b38", paddingTop: 16 }}>
      <h3>{print.print_id}</h3>

      <CorrectionNotices notes={print.correction_notes ?? []} />

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
