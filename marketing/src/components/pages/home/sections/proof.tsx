import { DocumentHeader } from "@/components/ui/document-header";

// Verified real, not invented: commit 56d47f7 ("Arc seller-b swaps qwen-2.5-72b for
// gpt-5.4-mini") — same task, two sellers, live on Arc Testnet. Confirmed live there: real SIU
// (quote-side) spread 14.9x, real settled-dollar spread ~23x ($0.0338 vs $0.001466).
const DEMO_DOC_URL =
  "https://github.com/petrkrulis2022/dated-siu-inference/blob/main/docs/demo-arc.md";

/**
 * @ployComponent
 * @ployComponentId touchstone-proof
 * @ployComponentType section
 * @ployComponentPattern proof-point
 * @ployComponentDescription Real, verified Arc Testnet cost-spread proof point.
 * @ployComponentStatus stable
 */
export function Proof() {
  return (
    <section className="proof mx-auto max-w-7xl px-5 py-20 md:px-8 md:py-28" aria-labelledby="proof-title">
      <DocumentHeader label="Live proof" title="Two sellers, identical work, live on Arc." />
      <div className="mt-14 border-y border-ploy-border-primary">
        <div className="grid md:grid-cols-2">
          <div className="border-b border-ploy-border-primary py-7 md:border-b-0 md:border-r md:pr-8">
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-ploy-text-secondary">Quote-side spread, priced in SIU</p>
            <p className="mt-3 font-mono text-5xl tabular-nums text-ploy-accent-primary">14.9x</p>
          </div>
          <div className="py-7 md:pl-8">
            <p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-ploy-text-secondary">Real settled spread ($0.0338 vs $0.001466)</p>
            <p className="mt-3 font-mono text-5xl tabular-nums text-ploy-accent-primary">~23x</p>
          </div>
        </div>
      </div>
      <p id="proof-title" className="mt-10 max-w-4xl font-heading text-2xl leading-snug md:text-3xl">Headline token prices underpredicted the real cost gap by roughly half.</p>
      <div className="mt-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <p className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-ploy-text-secondary">Testbed — Arc Testnet, not mainnet, not traction</p>
        <a href={DEMO_DOC_URL} className="group flex items-center gap-2 font-mono text-sm hover:text-ploy-accent-primary">
          Read the demo documentation <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">→</span>
        </a>
      </div>
    </section>
  );
}
