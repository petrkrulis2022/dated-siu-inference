import { Navbar } from "@/components/sections/navbar";
import { DocumentHeader } from "@/components/ui/document-header";
import { PUBLICATION_URL } from "@/components/pages/home/content";
import {
  LLMS_TXT_URL,
  MCP_CONFIG_JSON,
  MCP_JSON_URL,
  MCP_TOOLS,
  NETWORK_NOTE,
} from "@/lib/mcp-info";
import { TryItHerePanel } from "./components/try-it-here-panel";

/**
 * @ployComponent
 * @ployComponentId touchstone-for-agents
 * @ployComponentType page
 * @ployComponentPattern documentation
 * @ployComponentDescription Machine- and human-readable MCP reference: config, tools, prices, and a live demo panel.
 * @ployComponentStatus stable
 */

/**
 * Everything above <TryItHerePanel> is plain server-rendered content — fully readable by a plain
 * HTTP client with no JavaScript, per the explicit requirement that an agent fetching this page
 * shouldn't need to execute anything to read it. The page still mounts with client:load (see
 * for-agents.astro) because TryItHerePanel's buttons and WebMCP registration are genuinely
 * interactive — but client:load only changes when JS attaches, never whether this HTML exists in
 * the initial response.
 */
export function ForAgentsPage() {
  return (
    <>
      <Navbar activeMode="for-agents" />
      <div className="mx-auto max-w-7xl px-5 pb-24 pt-14 md:px-8">
        <DocumentHeader
          label="For agents"
          title="A measurement interface for agents."
          copy="Touchstone Assay's four MCP tools, live on Base Sepolia — a testbed, not traction. get_index is free; the other three settle in USDC over x402 via Circle Gateway."
        />

        <section className="mt-14 border-t border-ploy-border-primary pt-14" aria-labelledby="mcp-config-title">
          <h2 id="mcp-config-title" className="font-heading text-3xl font-normal md:text-4xl">MCP config</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-ploy-text-secondary">Streamable HTTP. Paste this into a client that supports remote MCP servers.</p>
          <pre className="mt-6 overflow-x-auto border border-ploy-border-primary bg-ploy-neutral-primary-s2 p-5 font-mono text-sm leading-6">{MCP_CONFIG_JSON}</pre>
          <p className="mt-4 font-mono text-xs text-ploy-text-secondary">
            Machine-readable: <a href="/mcp.json" className="border-b border-current hover:text-ploy-accent-primary">{MCP_JSON_URL}</a>{" "}
            · <a href="/llms.txt" className="border-b border-current hover:text-ploy-accent-primary">{LLMS_TXT_URL}</a>
          </p>
        </section>

        <section className="mt-14 border-t border-ploy-border-primary pt-14" aria-labelledby="tools-title">
          <h2 id="tools-title" className="font-heading text-3xl font-normal md:text-4xl">Tools</h2>
          <div className="mt-8 border-y border-ploy-border-primary">
            {MCP_TOOLS.map((tool, index) => (
              <div
                key={tool.name}
                className={`grid gap-3 py-5 md:grid-cols-12 md:items-baseline ${index > 0 ? "border-t border-ploy-border-primary" : ""}`}
              >
                <code className="font-mono text-sm md:col-span-3">{tool.name}</code>
                <p className="text-sm leading-6 text-ploy-text-secondary md:col-span-7">{tool.description}</p>
                <span className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-ploy-accent-primary md:col-span-2 md:text-right">
                  {tool.free ? "FREE" : `$${tool.priceUsd}`}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-ploy-text-secondary">{NETWORK_NOTE} Prices settle in USDC via Circle Gateway nanopayments — an x402 402 challenge, paid, then the tool result.</p>
        </section>

        <section className="mt-14 border-t border-ploy-border-primary pt-14" aria-labelledby="what-this-is-title">
          <h2 id="what-this-is-title" className="font-heading text-3xl font-normal md:text-4xl">What this is, plainly</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-ploy-text-secondary">
            A measurement standard and data publication — never &ldquo;backed by,&rdquo; never a peg, never an oracle,
            nothing for sale. <code>verify_receipt</code>&apos;s on-chain read is live, reading the real deployed
            TouchstoneEscrow contract — see the <a href={PUBLICATION_URL} className="border-b border-current hover:text-ploy-accent-primary">published prints</a> for the current print and the full methodology.
          </p>
        </section>

        <TryItHerePanel />
      </div>
    </>
  );
}
