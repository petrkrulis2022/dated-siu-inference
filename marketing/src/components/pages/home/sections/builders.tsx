import { DocumentHeader } from "../components/document-header";
import { PUBLICATION_URL } from "../content";

const tools = [
  ["get_quote", "Retrieve a comparable SIU quote for an inference offer."],
  ["convert", "Convert model-native units and prices into SIU."],
  ["verify_receipt", "Check a receipt against the signed print and methodology version."],
  ["get_index", "Read the current index and publication metadata.", "FREE"],
] as const;

/**
 * @ployComponent
 * @ployComponentId touchstone-builders
 * @ployComponentType section
 * @ployComponentPattern developer-tools
 * @ployComponentDescription MCP tool reference and publication links for builders.
 * @ployComponentStatus stable
 */
export function Builders() {
  return (
    <section id="builders" className="builders mx-auto max-w-7xl px-5 py-20 md:px-8 md:py-28" aria-labelledby="builders-title">
      <DocumentHeader label="For builders" title="A measurement interface for agents." copy="The MCP server exposes four narrow tools for reading, converting and verifying quotes." />
      <div className="mt-14 border-y border-ploy-border-primary">
        {tools.map(([name, copy, note], index) => <div key={name} className={`grid gap-3 py-5 md:grid-cols-12 md:items-baseline ${index > 0 ? "border-t border-ploy-border-primary" : ""}`}><code className="font-mono text-sm md:col-span-3">{name}</code><p className="text-sm leading-6 text-ploy-text-secondary md:col-span-7">{copy}</p><span className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-ploy-accent-primary md:col-span-2 md:text-right">{note ?? "MCP TOOL"}</span></div>)}
      </div>
      <div className="mt-10 grid gap-7 md:grid-cols-12">
        <p id="builders-title" className="max-w-2xl leading-7 text-ploy-text-secondary md:col-span-7">The methodology is published, versioned and tied to every print.</p>
        <div id="published-prints" className="flex flex-col items-start gap-4 font-mono text-sm md:col-span-5 md:items-end">
          <a href={PUBLICATION_URL} className="border-b border-current pb-1 hover:text-ploy-accent-primary">Published prints and methodology</a>
          <a href="#" className="text-ploy-text-secondary hover:text-ploy-accent-primary">Methodology document →</a>
        </div>
      </div>
    </section>
  );
}
