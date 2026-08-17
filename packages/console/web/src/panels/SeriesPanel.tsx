import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, type PrintRow } from "../lib/api.js";

export function SeriesPanel(): React.JSX.Element {
  const [prints, setPrints] = useState<PrintRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .prints()
      .then(setPrints)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const chartData = (prints ?? []).map((p) => ({
    date: p.date,
    provisional: p.status === "provisional" ? Number(p.dated_siu) : null,
    final: p.status === "final" ? Number(p.dated_siu) : null,
  }));

  return (
    <div className="panel">
      <h2>Dated SIU over time</h2>
      <p className="muted">
        A falling line is normal and expected: one SIU always buys the same work, so a falling line
        means inference got cheaper, not that the measurement is drifting.
      </p>
      {error && <p className="bad">{error}</p>}
      {prints && prints.length === 0 && (
        <p className="empty">No prints published yet — this chart populates once one exists.</p>
      )}
      {prints && prints.length > 0 && (
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#262b38" />
            <XAxis dataKey="date" stroke="#8b91a3" fontSize={12} />
            <YAxis stroke="#8b91a3" fontSize={12} />
            <Tooltip contentStyle={{ background: "#131722", border: "1px solid #262b38" }} />
            <Legend />
            <Line
              type="monotone"
              dataKey="final"
              name="final"
              stroke="#3ecf8e"
              connectNulls
              dot={{ r: 3 }}
            />
            <Line
              type="monotone"
              dataKey="provisional"
              name="provisional"
              stroke="#f5b84f"
              strokeDasharray="4 4"
              connectNulls
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
