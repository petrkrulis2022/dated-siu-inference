/**
 * A minimal, generated, self-contained local page -- same convention as `studio/studio-page.ts` (no server, no new dependency, read from a stored file, never a live run):
 * one agent's full step-by-step turns from a single run's own ordered log, in order -- its stated reasoning (`parsed.reasoning`, verbatim), the provider's own SEPARATE
 * reasoning/thinking summary where one exists (`ChatReply.reasoning`, wired through in this same build), its own actions, what it paid and was paid, and -- where the log
 * carries it directly (the hedger's own "objective" entries) -- its running economic objective.
 *
 * "This agent's own entries, plus any settlement for an escrow headed to it" is a best-effort presentation join, not a scoring reconstruction: it reuses no logic from
 * `scoring.ts`, and nothing here is a pre-registered number.
 */
import { readFileSync } from "node:fs";
import type { LogEntry } from "./log.js";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function loadLog(path: string): LogEntry[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LogEntry);
}

interface Step {
  seq: number;
  window: string;
  round: number;
  kind: string;
  summary: string;
  reasoning?: string;
  providerSummary?: string;
}

const str = (e: LogEntry, field: string): string | undefined => {
  const v = e[field];
  return typeof v === "string" || typeof v === "bigint" || typeof v === "number" ? String(v) : undefined;
};

function summarize(e: LogEntry, agent: string): string {
  switch (e.kind) {
    case "turn":
      return `tool: ${str(e, "tool") ?? "?"}${e.parsed === false ? " (could not be read)" : ""}`;
    case "message":
      return `message to ${str(e, "to") ?? "?"}: "${str(e, "text") ?? ""}"`;
    case "data-purchase":
      return `bought ${str(e, "dataset") ?? ""} data for ${str(e, "usdc") ?? str(e, "agu") ?? "?"} ${e.payUnit === "agu" ? "AGU-lab" : "USDC"}`;
    case "quote":
      return `posted a quote: ${str(e, "priceUnit") ?? "siu"} price${str(e, "priceUsdcMicro") !== undefined ? ` (${str(e, "priceUsdcMicro")} USDC)` : ""}`;
    case "escrow-open":
      return `${e.actor === agent ? "paid into escrow" : "received into escrow"}: ${str(e, "agu") ?? str(e, "usdc") ?? "?"} ${e.agu !== undefined ? "AGU-lab" : "USDC"}, to ${str(e, "to") ?? ""}`;
    case "escrow-settle":
      return `escrow settled: ${str(e, "paid") ?? "0"} paid, ${str(e, "refunded") ?? "0"} refunded`;
    case "receipt":
      return `receipt: ${str(e, "verdict") ?? ""}, ${str(e, "agu") ?? str(e, "usdc") ?? "0"}`;
    case "gate":
      return `gate: ${e.passed === true ? "PASSED" : "FAILED"}`;
    case "claim-mint":
      return `bought a work claim: ${str(e, "milli") ?? ""} mSIU of ${str(e, "task") ?? ""} for window ${str(e, "forWindow") ?? ""} (${e.payUnit === "agu" ? "AGU-lab" : "USDC"})`;
    case "need-lapsed":
      return `a need lapsed unmet: charged ${str(e, "costMicroSiu") ?? "?"} micro-SIU to the objective`;
    case "objective":
      return `objective update: ${str(e, "onTimeThisWindow") ?? "0"} on time, ${str(e, "lateThisWindow") ?? "0"} late (owed by now: ${str(e, "owedByNow") ?? "?"}, delivered: ${str(e, "deliveredByNow") ?? "?"})`;
    case "exit":
      return `exited to USDC: ${str(e, "agu") ?? "?"} AGU-lab -> ${str(e, "usdc") ?? "?"} USDC`;
    case "notice":
      return str(e, "text") ?? "(notice)";
    case "error":
      return `refused: ${str(e, "tool") ?? "?"} -- ${str(e, "refused") ?? "?"}`;
    default:
      return e.kind;
  }
}

/** every model agent that ever reasoned in this log, in first-appearance order -- the log's own ordered record, nothing from params */
export function modelAgentsIn(log: readonly LogEntry[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const e of log)
    if (e.kind === "reasoning" && !seen.has(e.actor)) {
      seen.add(e.actor);
      order.push(e.actor);
    }
  return order;
}

/** this agent's own entries, plus any settlement/gate/receipt entry for an escrow it opened or was the named counterparty ("to") of */
export function stepsFor(log: readonly LogEntry[], agent: string): Step[] {
  const escrowTo = new Map<string, string>();
  for (const e of log) if (e.kind === "escrow-open" && typeof e.escrow === "string") escrowTo.set(e.escrow, str(e, "to") ?? "");
  const relevant = log.filter((e) => {
    if (e.actor === agent) return true;
    const escrow = typeof e.escrow === "string" ? e.escrow : undefined;
    return escrow !== undefined && escrowTo.get(escrow) === agent;
  });
  const steps: Step[] = [];
  let pending: { text?: string; providerSummary?: string } | undefined;
  for (const e of relevant) {
    if (e.kind === "reasoning" && e.actor === agent) {
      pending = { text: str(e, "text"), providerSummary: str(e, "providerSummary") };
      continue;
    }
    steps.push({
      seq: e.seq,
      window: e.window,
      round: e.round,
      kind: e.kind,
      summary: summarize(e, agent),
      ...(pending?.text !== undefined ? { reasoning: pending.text } : {}),
      ...(pending?.providerSummary !== undefined ? { providerSummary: pending.providerSummary } : {}),
    });
    if (e.kind === "turn") pending = undefined; // the reasoning before a "turn" entry belongs to that turn alone
  }
  return steps;
}

function rowsFor(steps: readonly Step[]): string {
  return steps
    .map((s) => {
      const reasoningBlock =
        s.reasoning !== undefined
          ? `<details open><summary>reasoning</summary><pre>${escapeHtml(s.reasoning)}</pre></details>`
          : "";
      const summaryBlock =
        s.providerSummary !== undefined
          ? `<details><summary>provider reasoning summary</summary><pre>${escapeHtml(s.providerSummary)}</pre></details>`
          : "";
      return `<tr><td>${s.seq}</td><td>${escapeHtml(s.window)} r${s.round}</td><td><code>${escapeHtml(s.kind)}</code></td><td>${escapeHtml(s.summary)}</td><td>${reasoningBlock}${summaryBlock}</td></tr>`;
    })
    .join("\n");
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; max-width: 1200px; margin-inline: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #8884; padding: 6px 10px; text-align: left; vertical-align: top; font-size: .86rem; }
  th { background: #8882; }
  pre { white-space: pre-wrap; font-size: .8rem; background: #8881; padding: 8px; border-radius: 6px; max-width: 520px; }
  details { margin-bottom: 4px; }
  details summary { cursor: pointer; opacity: .8; }
  .note { opacity: .8; max-width: 80ch; }
`;

export function renderStepPage(log: readonly LogEntry[], agent: string): string {
  const steps = stepsFor(log, agent);
  const rows = rowsFor(steps);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(agent)} — step by step</title>
<style>${PAGE_STYLE}</style></head>
<body>
<h1>${escapeHtml(agent)} — every step, in order</h1>
<p class="note">Read-only, from this run's own ordered log alone (never a live run): ${escapeHtml(agent)}'s own actions, plus any settlement/gate/receipt for an escrow headed to it. "reasoning" is the model's own stated reasoning before that turn's action; "provider reasoning summary" is the model's separate thinking summary (<code>ChatReply.reasoning</code>), shown only on the turns a provider actually returned one. This is a presentation join, not a scoring reconstruction -- nothing here is a pre-registered number.</p>
<table><thead><tr><th>seq</th><th>when</th><th>kind</th><th>what happened</th><th>reasoning</th></tr></thead><tbody>
${rows}
</tbody></table>
</body></html>
`;
}

/**
 * One combined, self-contained page for a whole run: every model agent's full step-by-step turns, one section each, with a sidebar nav and (when supplied) the
 * run's own pre-registered scoring text verbatim at the top. Same convention as `renderStepPage` -- no server, no new dependency, read from a stored log alone.
 */
export function renderCombinedRunPage(
  log: readonly LogEntry[],
  agents: readonly string[],
  opts: { title?: string; scoringText?: string; runId?: string } = {},
): string {
  const title = opts.title ?? "CR economy run — every agent, step by step";
  const nav = agents.map((a) => `<li><a href="#${escapeHtml(a)}">${escapeHtml(a)}</a></li>`).join("\n");
  const sections = agents
    .map((a) => {
      const rows = rowsFor(stepsFor(log, a));
      return `<section id="${escapeHtml(a)}">
  <h2>${escapeHtml(a)}</h2>
  <table><thead><tr><th>seq</th><th>when</th><th>kind</th><th>what happened</th><th>reasoning</th></tr></thead><tbody>
${rows}
  </tbody></table>
</section>`;
    })
    .join("\n");
  const scoringBlock =
    opts.scoringText === undefined
      ? ""
      : `<section id="scoring"><h2>Pre-registered scoring</h2><pre>${escapeHtml(opts.scoringText)}</pre></section>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}
  body { display: flex; gap: 24px; align-items: flex-start; max-width: none; }
  nav { position: sticky; top: 24px; flex: 0 0 160px; }
  nav ul { list-style: none; padding: 0; margin: 0; }
  nav li { margin-bottom: 4px; }
  main { flex: 1 1 auto; min-width: 0; max-width: 1200px; }
  section { margin-bottom: 40px; }
  section pre { max-width: none; }
</style></head>
<body>
<nav><h3>${opts.runId !== undefined ? escapeHtml(opts.runId) : "Agents"}</h3><ul>
${opts.scoringText !== undefined ? '<li><a href="#scoring">Scoring</a></li>' : ""}
${nav}
</ul></nav>
<main>
<p class="note">Read-only, from this run's own ordered log alone (never a live run). Each section is one agent's full step-by-step record: reasoning, actions, payments. This is a presentation join, not a scoring reconstruction -- the Scoring section above is the pre-registered numbers verbatim, unrelated to this page's own rendering.</p>
${scoringBlock}
${sections}
</main>
</body></html>
`;
}
