/**
 * Agent Studio, screen 1: a single self-contained HTML file, opened from disk — same convention as the reasoning-tagging page (`reasoning/tag-page.ts`), no server, no build
 * step, no new dependency. Read-only: shows the roster `roster.ts` built exactly as it is, nothing editable yet (Part 2's items 2 onward, not built).
 */
import type { AgentConfig, StudioRoster } from "./roster.js";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ROLE_LABEL: Record<string, string> = {
  research: "RESEARCH",
  demand: "DEMAND",
  hedger: "HEDGER",
  participant: "PARTICIPANT (code, not a model)",
};

function agentCard(a: AgentConfig): string {
  const rows: string[] = [];
  rows.push(`<div class="kv"><span>Starting USDC</span><span>${escapeHtml(a.startingUsdc)}</span></div>`);
  rows.push(`<div class="kv"><span>Starting AGU-lab</span><span>${escapeHtml(a.startingAgu)}</span></div>`);

  if (a.mandate !== undefined) {
    rows.push(`<div class="kv"><span>Spend limit (AGU-lab/window)</span><span>${escapeHtml(a.mandate.spendLimitAgu)}</span></div>`);
    rows.push(`<div class="kv"><span>Minimum USDC buffer</span><span>${escapeHtml(a.mandate.minUsdcBuffer)}</span></div>`);
    rows.push(`<div class="kv"><span>Holding ceiling</span><span>${a.mandate.holdingCeilingDays} day(s) of upcoming work, at the reference brief price (computed live, not a fixed number)</span></div>`);
    rows.push(`<div class="kv"><span>USDC sweep days</span><span>${a.mandate.sweepDays.join(", ")}</span></div>`);
  }
  if (a.hedger !== undefined) {
    rows.push(`<div class="kv"><span>Forward briefs owed</span><span>${a.hedger.briefsSold}</span></div>`);
    rows.push(
      `<div class="kv"><span>Price per brief (narrative only)</span><span>${escapeHtml(a.hedger.priceUsdcPerBriefNarrativeOnly)} USDC <em>— no "sale" transaction exists anywhere in the log; this is backstory, not a mechanic (D131, D133)</em></span></div>`,
    );
  }
  if (a.participant !== undefined) {
    rows.push(`<div class="kv"><span>Spread</span><span>${(a.participant.spreadBps / 100).toFixed(2)}%</span></div>`);
    rows.push(`<div class="kv"><span>Buyback cap</span><span>${(a.participant.buybackCapBps / 100).toFixed(2)}% of the window's opening supply</span></div>`);
  }

  const tools =
    a.tools === undefined
      ? ""
      : `<div class="kv"><span>Tools</span><span>${a.tools.map((t) => `<code>${escapeHtml(t)}</code>`).join(" ")}</span></div>`;

  const needs =
    a.needsByWindow === undefined
      ? ""
      : `<details><summary>Real needs by window (${a.needsByWindow.length})</summary>
          <table class="needs"><thead><tr><th>Window</th><th>Day</th><th>Tasks needed</th></tr></thead><tbody>
          ${a.needsByWindow.map((n) => `<tr><td>${n.window}</td><td>${escapeHtml(n.day ?? "")}</td><td>${n.tasks.join(" + ")}</td></tr>`).join("\n")}
          </tbody></table></details>`;

  const instructions =
    a.instructions === undefined
      ? ""
      : `<details><summary>Role instructions, verbatim</summary><pre>${escapeHtml(a.instructions)}</pre></details>`;

  return `<section class="card">
    <div class="card-head"><h2>${escapeHtml(a.id)}</h2><span class="role role-${a.role}">${escapeHtml(ROLE_LABEL[a.role] ?? a.role)}</span></div>
    ${rows.join("\n")}
    ${tools}
    ${needs}
    ${instructions}
  </section>`;
}

export function renderStudioPage(roster: StudioRoster): string {
  const seatRows = roster.seatSchedule
    .map((s) => `<tr><td>${s.window}</td><td>${escapeHtml(s.day ?? "")}</td><td>${escapeHtml(s.model)}</td></tr>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Studio — the counted run's roster</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; max-width: 980px; margin-inline: auto; }
  h1 { font-size: 1.3rem; }
  .note { opacity: .8; font-size: .92rem; max-width: 70ch; }
  table.seats { border-collapse: collapse; margin: 12px 0 24px; }
  table.seats th, table.seats td, table.needs th, table.needs td { border: 1px solid #8884; padding: 4px 10px; text-align: left; font-size: .9rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
  .card { border: 1px solid #8884; border-radius: 10px; padding: 14px 16px; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .card-head h2 { margin: 0; font-size: 1.05rem; }
  .role { font-size: .72rem; padding: 2px 8px; border-radius: 999px; background: #8882; white-space: nowrap; }
  .kv { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; border-bottom: 1px dotted #8883; font-size: .88rem; }
  .kv span:first-child { opacity: .7; }
  .kv span:last-child { text-align: right; }
  code { background: #8882; padding: 1px 5px; border-radius: 4px; font-size: .82rem; }
  details { margin-top: 8px; }
  details summary { cursor: pointer; font-size: .85rem; opacity: .85; }
  pre { white-space: pre-wrap; font-size: .82rem; background: #8881; padding: 10px; border-radius: 8px; }
  table.needs { width: 100%; margin-top: 6px; }
</style></head>
<body>
<h1>Agent Studio — screen 1: the seven, as they ran</h1>
<p class="note">Read-only, built from the committed parameters file and the instructions code — not from a live run or a stored log, so this is what any run WOULD see, not a record of what happened in one. Nothing here is editable yet (Part 2, items 2 onward). Real seed used to compute each demand agent's needs: <code>${escapeHtml(roster.seed)}</code> — never the committed file's own default seed, the exact mistake D133 found in the scorer.</p>
<h2>Seat schedule (shared by all six model-driven agents, v1's own design — see the redesign note on whether this stays shared in v2)</h2>
<table class="seats"><thead><tr><th>Window</th><th>Day</th><th>Model</th></tr></thead><tbody>
${seatRows}
</tbody></table>
<h2>The seven</h2>
<div class="grid">
${roster.agents.map(agentCard).join("\n")}
</div>
</body></html>
`;
}
