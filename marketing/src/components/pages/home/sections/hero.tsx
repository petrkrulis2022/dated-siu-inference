import { CURRENT_PRINT, PUBLICATION_URL } from "../content";

/**
 * @ployComponent
 * @ployComponentId touchstone-hero
 * @ployComponentType section
 * @ployComponentPattern hero
 * @ployComponentDescription Homepage masthead and authoritative Dated SIU print display.
 * @ployComponentStatus stable
 */
export function Hero() {
  return (
    <section className="hero border-b border-ploy-border-primary" aria-labelledby="hero-title">
      <div className="hero__ticker bg-ploy-background-inverse text-ploy-text-inverse">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 overflow-x-auto px-5 py-3 font-mono text-[0.65rem] uppercase tracking-[0.12em] md:px-8">
          <span className="whitespace-nowrap">Dated SIU <b className="font-medium">{CURRENT_PRINT.value}</b></span>
          <span className="whitespace-nowrap text-ploy-text-inverse-secondary">Settlement / USDC</span>
          <span className="whitespace-nowrap text-ploy-text-inverse-secondary">Index print / Weekly · Signed</span>
          <span className="whitespace-nowrap text-ploy-text-inverse-secondary">Method / Versioned</span>
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-5 pb-16 pt-7 md:px-8 md:pb-24 md:pt-10">
        <nav className="hero__nav flex items-center justify-between gap-6 border-b border-ploy-border-primary pb-7" aria-label="Primary navigation">
          <a href="#top" className="group flex min-w-0 items-center gap-3" aria-label="Touchstone Assay home">
            <span className="relative block size-8 shrink-0 bg-ploy-background-inverse after:absolute after:bottom-2 after:left-2 after:h-px after:w-4 after:-rotate-[34deg] after:bg-ploy-background-primary" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block truncate font-heading text-xl tracking-[0.04em] md:text-2xl">TOUCHSTONE ASSAY</span>
              <span className="block truncate font-mono text-[0.5rem] uppercase tracking-[0.26em] text-ploy-text-secondary">AI inference index &amp; pricing</span>
            </span>
          </a>
          <div className="hidden items-center gap-7 font-mono text-[0.65rem] uppercase tracking-[0.13em] md:flex">
            <a href="#method" className="hover:text-ploy-accent-primary">Method</a>
            <a href="#builders" className="hover:text-ploy-accent-primary">For builders</a>
            <a href={PUBLICATION_URL} className="border-b border-current pb-1 hover:text-ploy-accent-primary">Full series</a>
          </div>
        </nav>

        <div className="hero__copy grid gap-10 pt-14 md:grid-cols-12 md:gap-8 md:pt-20">
          <div className="md:col-span-8">
            <h1 id="hero-title" className="hero__title max-w-4xl text-balance font-heading text-5xl font-normal leading-[0.98] tracking-[-0.025em] md:text-7xl">Touchstone Assay publishes Dated SIU.</h1>
            <p className="mt-7 max-w-2xl font-heading text-2xl leading-tight text-ploy-text-secondary md:text-3xl">The benchmark price of AI inference work.</p>
          </div>
          <div className="max-w-md md:col-span-4 md:pt-2"><p className="text-base leading-7 text-ploy-text-secondary">One SIU is a fixed quantity of AI work: a versioned benchmark basket of inference tasks completed at a defined quality threshold.</p><p className="mt-5 font-mono text-[0.62rem] uppercase tracking-[0.16em] text-ploy-text-secondary">A measurement standard · not a currency · nothing for sale</p></div>
        </div>

        <div className="hero__print mt-14 border-y border-ploy-border-primary md:mt-20">
          <div className="grid md:grid-cols-12">
            <div className="border-b border-ploy-border-primary py-5 md:col-span-3 md:border-b-0 md:border-r md:pr-8">
              <p className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-ploy-text-secondary">Dated SIU</p>
              <p className="mt-3 font-mono text-4xl tabular-nums md:text-5xl">{CURRENT_PRINT.value}</p>
            </div>
            <dl className="grid grid-cols-2 gap-px py-5 md:col-span-5 md:grid-cols-2 md:px-8">
              <div><dt className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-ploy-text-secondary">Publication date</dt><dd className="mt-3 font-mono text-sm tabular-nums">{CURRENT_PRINT.date}</dd></div>
              <div><dt className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-ploy-text-secondary">Status</dt><dd className="mt-3 font-mono text-sm text-ploy-accent-primary">{CURRENT_PRINT.status}</dd></div>
            </dl>
            <a href={PUBLICATION_URL} className="group flex items-center justify-between border-t border-ploy-border-primary py-5 font-mono text-sm md:col-span-4 md:border-l md:border-t-0 md:pl-8">
              <span>View the full series</span><span aria-hidden="true" className="transition-transform group-hover:translate-x-1">→</span>
            </a>
          </div>
        </div>
        <p className="mt-5 font-heading text-lg italic text-ploy-text-secondary">A falling price is normal — one SIU always buys the same work.</p>
      </div>
    </section>
  );
}
