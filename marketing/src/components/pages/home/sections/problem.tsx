import { DocumentHeader } from "../components/document-header";

const priceUnits = [
  ["Per token", "Input, output and reasoning tokens vary by tokenizer and model behavior."],
  ["Per task", "A nominal task says nothing about whether the result met a common quality bar."],
  ["Per outcome", "Outcome contracts bundle intelligence, risk and workflow into one incomparable price."],
] as const;

/**
 * @ployComponent
 * @ployComponentId touchstone-problem
 * @ployComponentType section
 * @ployComponentPattern feature-comparison
 * @ployComponentDescription Explains incompatible AI inference pricing units.
 * @ployComponentStatus stable
 */
export function Problem() {
  return (
    <section className="problem mx-auto max-w-7xl px-5 py-20 md:px-8 md:py-28" aria-labelledby="problem-title">
      <DocumentHeader label="The problem" title="Intelligence has no common unit of account." />
      <div className="mt-12 grid border-y border-ploy-border-primary md:grid-cols-3">
        {priceUnits.map(([title, copy], index) => (
          <article key={title} className={`py-7 md:px-7 md:py-9 ${index > 0 ? "border-t border-ploy-border-primary md:border-l md:border-t-0" : ""}`}>
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-ploy-text-secondary">Quoted {title.toLowerCase()}</p>
            <h3 className="mt-8 font-heading text-3xl font-normal">{title}</h3>
            <p className="mt-4 max-w-sm text-sm leading-6 text-ploy-text-secondary">{copy}</p>
          </article>
        ))}
      </div>
      <p id="problem-title" className="mt-10 max-w-4xl font-heading text-2xl leading-snug md:text-3xl">Every model prices in incompatible tokens — different tokenizers, different verbosity, reasoning tokens billed as output — so neither a finance team nor an AI agent can compare what a unit of intelligence actually costs.</p>
    </section>
  );
}
