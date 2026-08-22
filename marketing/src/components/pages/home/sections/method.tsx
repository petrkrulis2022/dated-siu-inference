const evidence = [
  ["01", "Executed runs", "Primary evidence. Inference is purchased and measured against the current basket."],
  ["02", "Routed-market flows", "Observed clearing behavior supplements direct executions."],
  ["03", "Published list prices", "Context only. Never determinative of the print."],
] as const;

/**
 * @ployComponent
 * @ployComponentId touchstone-method
 * @ployComponentType section
 * @ployComponentPattern methodology
 * @ployComponentDescription Prominent verified-execution methodology and publication cadence.
 * @ployComponentStatus stable
 */
export function Method() {
  return (
    <section id="method" className="method bg-ploy-background-inverse text-ploy-text-inverse" aria-labelledby="method-title">
      <div className="mx-auto max-w-7xl px-5 py-20 md:px-8 md:py-32">
        <div className="grid gap-10 border-t border-ploy-border-inverse pt-6 md:grid-cols-12 md:gap-8">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.22em] text-ploy-text-inverse-secondary md:col-span-3">Method</p>
          <div className="md:col-span-9">
            <h2 id="method-title" className="text-balance font-heading text-5xl font-normal leading-none md:text-7xl">Verified, not surveyed.</h2>
            <p className="mt-9 max-w-4xl font-heading text-2xl leading-snug text-ploy-text-inverse md:text-3xl">Price reporting agencies survey the market; Touchstone Assay transacts in it.</p>
            <p className="mt-7 max-w-3xl text-base leading-7 text-ploy-text-inverse-secondary">Every print is measured by actually buying inference, reconciled against provider invoices, signed, and hash-anchored on chain so anyone can verify a published number was issued under a stated methodology version.</p>
          </div>
        </div>
        <div className="mt-16 grid border-y border-ploy-border-inverse md:grid-cols-3">
          {evidence.map(([number, title, copy], index) => <article key={title} className={`py-7 md:px-7 md:py-9 ${index > 0 ? "border-t border-ploy-border-inverse md:border-l md:border-t-0" : ""}`}><span className="font-mono text-xs text-ploy-accent-primary">{number}</span><h3 className="mt-8 font-heading text-2xl font-normal">{title}</h3><p className="mt-4 text-sm leading-6 text-ploy-text-inverse-secondary">{copy}</p></article>)}
        </div>
        <div className="mt-12 grid gap-8 md:grid-cols-12">
          <p className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-ploy-accent-primary md:col-span-3">Publication cadence</p>
          <p className="max-w-4xl leading-7 text-ploy-text-inverse-secondary md:col-span-9">Prints are published weekly on a stated schedule, marked provisional until reconciled against provider invoices, and corrections are published as numbered revisions alongside originals which are never edited or deleted.</p>
        </div>
      </div>
    </section>
  );
}
