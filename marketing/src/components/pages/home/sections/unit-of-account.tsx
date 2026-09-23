/**
 * @ployComponent
 * @ployComponentId touchstone-unit-of-account
 * @ployComponentType section
 * @ployComponentPattern statement
 * @ployComponentDescription Short thesis statement: the unit of account outlives instruments denominated in it.
 * @ployComponentStatus stable
 */
export function UnitOfAccount() {
  return (
    <section className="unit-of-account bg-ploy-background-inverse text-ploy-text-inverse" aria-labelledby="unit-of-account-title">
      <div className="mx-auto max-w-7xl px-5 py-16 md:px-8 md:py-20">
        <p className="font-mono text-[0.68rem] uppercase tracking-[0.22em] text-ploy-text-inverse-secondary">The thesis</p>
        <p id="unit-of-account-title" className="mt-6 max-w-4xl font-heading text-3xl font-normal leading-snug md:text-4xl">Touchstone defines and publishes the unit of account for AI work.</p>
        <p className="mt-5 max-w-3xl font-heading text-xl italic leading-snug text-ploy-text-inverse-secondary md:text-2xl">Units outlive the instruments denominated in them — that&rsquo;s why Brent matters more than any contract written against it.</p>
      </div>
    </section>
  );
}
