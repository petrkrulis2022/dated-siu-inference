import { useEffect, useState, useSyncExternalStore } from "react";
import { fetchLatestPrint } from "@/lib/mcp-client";
import { cn } from "@/lib/utils";

/**
 * @ployComponent
 * @ployComponentId touchstone-try-it-here-panel
 * @ployComponentType component
 * @ployComponentPattern live-demo
 * @ployComponentDescription Three free, read-only MCP tool calls, live in the browser, plus optional WebMCP registration.
 * @ployComponentStatus experimental
 */

/**
 * React port of site/src/client/try-it-here.ts's own logic — same three tools, same hard
 * guardrail: only get_current_print, explain_siu, compare_model_cost exist here, ever.
 * get_quote/convert/verify_receipt are paid tools behind x402 on the remote MCP server and are
 * never callable from this file. Nothing here signs, mints, or writes anything. No wSIU anywhere.
 * WebMCP (document.modelContext) is an experimental W3C Community Group proposal with no native
 * browser support yet — registration is a no-op everywhere until that changes, which is exactly
 * why every tool also has a plain button that works today regardless.
 */

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

interface WebMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: () => Promise<string>;
  annotations: { readOnlyHint: boolean; consequentialHint: boolean };
}
interface WebMcpModelContext {
  registerTool: (tool: WebMcpTool, options?: Record<string, unknown>) => Promise<void>;
}

function registerWithWebMcp(): void {
  const modelContext = (document as unknown as { modelContext?: WebMcpModelContext }).modelContext;
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

type ToolState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; text: string }
  | { status: "error"; message: string };

const IDLE_RESULTS: Record<string, ToolState> = Object.fromEntries(
  TOOLS.map((tool) => [tool.name, { status: "idle" }] as const),
);

const noopSubscribe = () => () => {};

export function TryItHerePanel() {
  // "modelContext" is a browser-only global (no native support anywhere yet), so this reads false
  // on the server and syncs to the real client value post-hydration without a setState-in-effect
  // — useSyncExternalStore is the sanctioned way to read synchronous external/browser state safely
  // across SSR and the client in the same render pass.
  const hasWebMcp = useSyncExternalStore(
    noopSubscribe,
    () => "modelContext" in document,
    () => false,
  );
  const [results, setResults] = useState<Record<string, ToolState>>(IDLE_RESULTS);

  useEffect(() => {
    if (hasWebMcp) registerWithWebMcp();
  }, [hasWebMcp]);

  const runTool = (tool: ToolDef) => {
    setResults((prev) => ({ ...prev, [tool.name]: { status: "loading" } }));
    tool
      .run()
      .then((text) => setResults((prev) => ({ ...prev, [tool.name]: { status: "done", text } })))
      .catch((err: unknown) =>
        setResults((prev) => ({
          ...prev,
          [tool.name]: {
            status: "error",
            message: `Couldn't reach the live index: ${err instanceof Error ? err.message : String(err)}`,
          },
        })),
      );
  };

  const statusText = hasWebMcp
    ? "WebMCP detected — these three tools are registered with your browser, in addition to the buttons below."
    : "WebMCP isn't supported in this browser yet (it's an experimental W3C proposal — see the plain MCP config above for the durable, remote way to connect). The buttons below still work directly.";

  return (
    <section className="mt-14 border-t border-ploy-border-primary pt-14" id="try-it-here" aria-labelledby="try-it-here-title">
      <h2 id="try-it-here-title" className="font-heading text-3xl font-normal md:text-4xl">Try it here</h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-ploy-text-secondary">{statusText}</p>
      <div className="mt-8 grid gap-6 md:grid-cols-3">
        {TOOLS.map((tool) => {
          const state = results[tool.name];
          return (
            <div key={tool.name} className="border border-ploy-border-primary p-5">
              <button
                type="button"
                onClick={() => runTool(tool)}
                disabled={state.status === "loading"}
                className={cn(
                  "w-full border border-ploy-border-primary px-3 py-2 text-left font-mono text-sm transition-colors",
                  "hover:bg-ploy-neutral-primary-s2 disabled:pointer-events-none disabled:opacity-50",
                )}
              >
                <code>{tool.name}</code>
              </button>
              <p className="mt-3 text-sm leading-6 text-ploy-text-secondary">{tool.description}</p>
              <pre className="mt-3 whitespace-pre-wrap wrap-break-word font-mono text-xs leading-5 text-ploy-text-primary">
                {state.status === "loading"
                  ? "Calling…"
                  : state.status === "done"
                    ? state.text
                    : state.status === "error"
                      ? state.message
                      : ""}
              </pre>
            </div>
          );
        })}
      </div>
      <p className="mt-6 max-w-2xl text-sm leading-6 text-ploy-text-secondary">
        Free, read-only, no exceptions — never <code>get_quote</code>, <code>convert</code>, or{" "}
        <code>verify_receipt</code>, which stay paid, on the remote server only. These three call
        the same live MCP server as the config above. If your browser or agent supports{" "}
        <a href="https://webmachinelearning.github.io/webmcp/" className="border-b border-current hover:text-ploy-accent-primary">
          WebMCP
        </a>{" "}
        — an experimental W3C Community Group proposal, not yet a shipped standard — they're also
        registered directly with <code>document.modelContext</code>, in addition to the buttons.
      </p>
    </section>
  );
}
