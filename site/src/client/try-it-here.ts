/**
 * Powers for-agents.html's "Try it here" section only — page-scoped, not sitewide (see
 * layout.ts's own mode-toggle.js for the sitewide script). Two jobs:
 *
 * 1. Wires the three buttons to real, live calls — every visitor gets these, WebMCP or not.
 * 2. If the browser supports WebMCP (document.modelContext — a W3C Community Group draft, not a
 *    shipped standard, so this degrades to "just the buttons" everywhere else today), also
 *    registers the same three tools so an agent operating in this browser can call them.
 *
 * Hard guardrail: only get_current_print, explain_siu, compare_model_cost exist here, ever.
 * get_quote/convert/verify_receipt are paid tools behind x402 on the remote MCP server and are
 * never callable from this file — this is a read-only, free demo surface, not a second front
 * door to the paid service. Nothing here signs, mints, or writes anything. No wSIU anywhere.
 */

import { fetchLatestPrint } from "./mcp-browser-client.js";

interface PrintShape {
  dated_siu?: string;
  date?: string;
  status?: string;
  exchange_rate_table?: { model_id: string; usd_per_siu?: string; spread_to_index?: string }[];
}

const EXPLAIN_SIU_TEXT =
  "One SIU (Standard Inference Unit) is a fixed basket of inference tasks (SIU-2026a) run " +
  "against real provider APIs at a defined quality threshold. The print is what that basket " +
  "cost, in dollars, the last time it was actually measured — never surveyed from list prices, " +
  "always computed from executed runs that passed the basket's own quality gate.";

function formatCurrentPrint(print: PrintShape): string {
  if (!print.dated_siu) return "The live response didn't include a dated_siu value.";
  const status = print.status ? ` (${print.status})` : "";
  const date = print.date ? ` — ${print.date}` : "";
  return `Dated SIU: $${print.dated_siu}${status}${date}`;
}

function formatCompareModelCost(print: PrintShape): string {
  const rows = print.exchange_rate_table;
  if (!rows || rows.length === 0) return "The live response didn't include an exchange_rate_table.";
  return rows
    .map((row) => {
      const rate = row.usd_per_siu ? `$${row.usd_per_siu}/SIU` : "excluded";
      const spread = row.spread_to_index ? ` (spread ${row.spread_to_index})` : "";
      return `${row.model_id}: ${rate}${spread}`;
    })
    .join("\n");
}

interface ToolDef {
  name: string;
  title: string;
  description: string;
  run: () => Promise<string>;
}

const TOOLS: ToolDef[] = [
  {
    name: "get_current_print",
    title: "Get current print",
    description: "Returns the current Dated SIU value, date, and status from the live, signed print.",
    run: async () => formatCurrentPrint((await fetchLatestPrint()) as PrintShape),
  },
  {
    name: "explain_siu",
    title: "Explain SIU",
    description: "Explains what one SIU is: the basket, the quality gate, how the print is computed.",
    run: async () => EXPLAIN_SIU_TEXT,
  },
  {
    name: "compare_model_cost",
    title: "Compare model cost",
    description: "Returns the current print's exchange-rate table — every constituent model's real cost, in SIU.",
    run: async () => formatCompareModelCost((await fetchLatestPrint()) as PrintShape),
  },
];

function statusEl(): HTMLElement | null {
  return document.getElementById("try-it-here-status");
}

function wireButtons(): void {
  for (const tool of TOOLS) {
    const button = document.querySelector<HTMLButtonElement>(`[data-tool="${tool.name}"]`);
    const resultEl = document.querySelector<HTMLElement>(`[data-tool-result="${tool.name}"]`);
    if (!button || !resultEl) continue;
    button.addEventListener("click", () => {
      button.disabled = true;
      resultEl.textContent = "Calling…";
      tool
        .run()
        .then((text) => {
          resultEl.textContent = text;
        })
        .catch((err: unknown) => {
          resultEl.textContent = `Couldn't reach the live index: ${err instanceof Error ? err.message : String(err)}`;
        })
        .finally(() => {
          button.disabled = false;
        });
    });
  }
}

function registerWithWebMcp(): void {
  const modelContext = (document as unknown as { modelContext?: unknown }).modelContext as
    | {
        registerTool: (
          tool: {
            name: string;
            title: string;
            description: string;
            inputSchema: Record<string, unknown>;
            execute: () => Promise<string>;
            annotations: { readOnlyHint: boolean; consequentialHint: boolean };
          },
          options?: Record<string, unknown>,
        ) => Promise<void>;
      }
    | undefined;
  if (!modelContext) return;

  for (const tool of TOOLS) {
    void modelContext.registerTool({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: tool.run,
      annotations: { readOnlyHint: true, consequentialHint: false },
    });
  }
}

function main(): void {
  wireButtons();
  const status = statusEl();
  const hasWebMcp = "modelContext" in document;
  if (status) {
    status.textContent = hasWebMcp
      ? "WebMCP detected — these three tools are registered with your browser, in addition to the buttons below."
      : "WebMCP isn't supported in this browser yet (it's an experimental W3C proposal — see the plain MCP config above for the durable, remote way to connect). The buttons below still work directly.";
  }
  if (hasWebMcp) registerWithWebMcp();
}

main();
