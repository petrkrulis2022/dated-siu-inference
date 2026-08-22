import { DocumentHeader } from "../components/document-header";

const sequence = [
  ["First", "The index and settlement rail", "Establish the measurement standard, publication record and payment-path quote extension."],
  ["Then", "Transferable claims and a settlement token", "Extend settlement mechanics only after the reference publication is established."],
  ["Thereafter", "Reference-rate licensing and derivatives support", "Support institutional use of the reference rate as the methodology matures."],
] as const;

/**
 * @ployComponent
 * @ployComponentId touchstone-roadmap
 * @ployComponentType section
 * @ployComponentPattern roadmap
 * @ployComponentDescription Sequenced, undated institutional roadmap.
 * @ployComponentStatus stable
 */
export function Roadmap() {
  return (
    <section className="roadmap bg-ploy-background-secondary" aria-labelledby="roadmap-title">
      <div className="mx-auto max-w-7xl px-5 py-20 md:px-8 md:py-28">
        <DocumentHeader label="Sequence" title="The publication comes first." copy="A sequence of intended work, not a schedule or promise." />
        <ol className="mt-14 border-y border-ploy-border-primary">
          {sequence.map(([phase, title, copy], index) => <li key={phase} className={`grid gap-4 py-7 md:grid-cols-12 md:gap-8 ${index > 0 ? "border-t border-ploy-border-primary" : ""}`}><span className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-ploy-accent-primary md:col-span-2">{phase}</span><h3 className="font-heading text-2xl font-normal md:col-span-4">{title}</h3><p className="max-w-xl text-sm leading-6 text-ploy-text-secondary md:col-span-6">{copy}</p></li>)}
        </ol>
        <span id="roadmap-title" className="sr-only">Roadmap</span>
      </div>
    </section>
  );
}
