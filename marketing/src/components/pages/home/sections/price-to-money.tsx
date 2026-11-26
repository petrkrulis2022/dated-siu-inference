import { DocumentHeader } from "@/components/ui/document-header";

// Status labels are deliberately literal. Only the first layer is live; the figures in its row
// (first print 18 August 2026, ten registered models) come from docs/traction-2026-11-01.md.
const layers = [
  {
    number: "01",
    title: "SIU, the unit",
    status: "Live since 18 August 2026",
    live: true,
    copy: "One standard basket of tasks that pass a machine check, priced daily across ten models.",
  },
  {
    number: "02",
    title: "Work claims",
    status: "Testnet",
    live: false,
    copy: "Tokenized claims on completed AI work. Dated, bonded claims designed to be sold forward by GPU owners and agent sellers; if they fail to deliver, the holder is paid from their bond.",
  },
  {
    number: "03",
    title: "A currency for agents",
    status: "Research",
    live: false,
    copy: "A share of a reserve of tokenized claims on completed AI work, so an agent can hold its budget in work rather than dollars.",
  },
] as const;

/**
 * @ployComponent
 * @ployComponentId touchstone-price-to-money
 * @ployComponentType section
 * @ployComponentPattern roadmap
 * @ployComponentDescription Where the project is going, from the published price to work claims and a currency for agents, each layer with its current status.
 * @ployComponentStatus stable
 */
export function PriceToMoney() {
  return (
    <section id="roadmap-money" className="price-to-money bg-ploy-background-secondary" aria-label="Roadmap: from a price to money">
      <div className="mx-auto max-w-7xl px-5 py-20 md:px-8 md:py-28">
        <DocumentHeader label="Roadmap" title="From a price to money." />
        <div className="mt-10 grid md:grid-cols-12 md:gap-8">
          <div className="space-y-5 md:col-span-9 md:col-start-4">
            <p className="max-w-3xl text-base leading-7 text-ploy-text-secondary">Today, Dated SIU is a price: the dollar cost of one standard basket of AI work, measured by paying for it and published as a signed print.</p>
            <p className="max-w-3xl text-base leading-7 text-ploy-text-secondary">Because one SIU always means the same work, others can build on it: a work claim can promise it, and an agent can hold it in place of dollars. A currency built this way is developed separately from the index, which stays a measurement standard. That is where the project is going, in three layers. Each depends on the one before it, and each carries its status today.</p>
            <p className="max-w-3xl text-base leading-7 text-ploy-text-secondary">The index comes first. It is measured and published the same way whatever is built on it, and the print is computed from executed runs only.</p>
          </div>
        </div>
        <ol className="mt-14 border-y border-ploy-border-primary">
          {layers.map((layer, index) => (
            <li key={layer.number} className={`grid gap-4 py-7 md:grid-cols-12 md:gap-8 ${index > 0 ? "border-t border-ploy-border-primary" : ""}`}>
              <span className="font-mono text-[0.62rem] tracking-[0.2em] text-ploy-text-secondary md:col-span-2">{layer.number}</span>
              <div className="md:col-span-4">
                <h3 className="font-heading text-2xl font-normal">{layer.title}</h3>
                <span className={`mt-3 inline-block border px-2 py-1 font-mono text-[0.58rem] uppercase tracking-[0.16em] ${layer.live ? "border-ploy-accent-primary text-ploy-accent-primary" : "border-ploy-border-primary text-ploy-text-secondary"}`}>{layer.status}</span>
              </div>
              <p className="max-w-xl text-sm leading-6 text-ploy-text-secondary md:col-span-6">{layer.copy}</p>
            </li>
          ))}
        </ol>
        <p className="mt-8 max-w-3xl border border-ploy-border-primary p-6 text-sm leading-6 text-ploy-text-secondary md:p-8">Work claims and the currency run on testnet only. Nothing is offered or sold, and nothing carries real value. They will only go live after an independent legal review, and after the index has moved to an independent foundation.</p>
      </div>
    </section>
  );
}
