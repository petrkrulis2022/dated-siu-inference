import { useEffect, useState } from "react";
import { api, type ConfigResponse } from "./lib/api.js";
import { SeriesPanel } from "./panels/SeriesPanel.js";
import { PrintsPanel } from "./panels/PrintsPanel.js";
import { ModelsPanel } from "./panels/ModelsPanel.js";
import { ActivityPanel } from "./panels/ActivityPanel.js";
import { QuotedVsPaidPanel } from "./panels/QuotedVsPaidPanel.js";
import { HealthPanel } from "./panels/HealthPanel.js";
import { ChatAnalyticsPanel } from "./panels/ChatAnalyticsPanel.js";

const TABS = [
  { id: "series", label: "Series" },
  { id: "prints", label: "Prints" },
  { id: "models", label: "Models" },
  { id: "activity", label: "Agent activity" },
  { id: "quoted-vs-paid", label: "Quoted vs paid" },
  { id: "health", label: "Health" },
  { id: "chat", label: "Chat analytics" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function App(): React.JSX.Element {
  const [tab, setTab] = useState<TabId>("series");
  const [config, setConfig] = useState<ConfigResponse | null>(null);

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  return (
    <div className="app">
      <div className="banner">
        Touchstone Assay operator console — read-only, localhost-only. Never writes to{" "}
        <code>data/</code>, never signs, never sends a transaction.
        {config ? ` Chain: ${config.chainName} (${config.chainId}).` : ""}
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "series" && <SeriesPanel />}
      {tab === "prints" && <PrintsPanel config={config} />}
      {tab === "models" && <ModelsPanel />}
      {tab === "activity" && <ActivityPanel config={config} />}
      {tab === "quoted-vs-paid" && <QuotedVsPaidPanel config={config} />}
      {tab === "health" && <HealthPanel config={config} />}
      {tab === "chat" && <ChatAnalyticsPanel />}
    </div>
  );
}
