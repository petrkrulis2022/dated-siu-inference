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
import { api, type ModelsResponse } from "../lib/api.js";

const COLORS = ["#5b9dff", "#3ecf8e", "#f5b84f", "#ff6b6b", "#c792ea", "#ffcb6b"];

export function ModelsPanel(): React.JSX.Element {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .models()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const modelIds = data ? Object.keys(data.rateHistory) : [];
  const dates = data
    ? [
        ...new Set(
          Object.values(data.rateHistory)
            .flat()
            .map((p) => p.date),
        ),
      ].sort()
    : [];
  const chartData = dates.map((date) => {
    const row: Record<string, string | number> = { date };
    for (const modelId of modelIds) {
      const point = data!.rateHistory[modelId]!.find((p) => p.date === date);
      if (point?.usd_per_siu) row[modelId] = Number(point.usd_per_siu);
    }
    return row;
  });

  return (
    <div className="panel">
      <h2>Models — exchange rate over time</h2>
      {error && <p className="bad">{error}</p>}
      {data && modelIds.length === 0 && (
        <p className="empty">No models have appeared in a print yet.</p>
      )}
      {data && modelIds.length > 0 && (
        <>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#262b38" />
              <XAxis dataKey="date" stroke="#8b91a3" fontSize={12} />
              <YAxis stroke="#8b91a3" fontSize={12} />
              <Tooltip contentStyle={{ background: "#131722", border: "1px solid #262b38" }} />
              <Legend />
              {modelIds.map((modelId, i) => (
                <Line
                  key={modelId}
                  type="monotone"
                  dataKey={modelId}
                  stroke={COLORS[i % COLORS.length]}
                  connectNulls
                  dot={{ r: 2 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>

          <h3>Gate pass/fail history</h3>
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Print</th>
                <th>Class</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {modelIds.flatMap((modelId) =>
                (data!.gateHistory[modelId] ?? []).map((g, i) => (
                  <tr key={`${modelId}-${i}`}>
                    <td>{modelId}</td>
                    <td>{g.print_id}</td>
                    <td>{g.task_class}</td>
                    <td className={g.passed ? "ok" : "bad"}>{g.passed ? "pass" : "fail"}</td>
                  </tr>
                )),
              )}
              {modelIds.every((m) => (data!.gateHistory[m] ?? []).length === 0) && (
                <tr>
                  <td colSpan={4} className="empty">
                    No run records yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
