import type { ReactNode } from "react";
import { DocumentHeader } from "@/components/ui/document-header";

/**
 * @ployComponent
 * @ployComponentId touchstone-analogy
 * @ployComponentType section
 * @ployComponentPattern process-diagram
 * @ployComponentDescription Commodity benchmark analogy with the triangular inference, SIU and dollar relationship.
 * @ployComponentStatus stable
 */
export function Analogy() {
  return (
    <section className="analogy bg-ploy-background-secondary" aria-labelledby="analogy-title">
      <div className="mx-auto max-w-7xl px-5 py-20 md:px-8 md:py-28">
        <DocumentHeader label="The analogy" title="The commodity, the grade, the settlement." copy="Oil never got its own currency. It got a benchmark grade — Dated Brent — priced in dollars. Inference follows the same pattern." />

        <figure className="mt-14" aria-labelledby="triangle-caption">
          <div className="grid gap-4 md:grid-cols-[1fr_8rem_1fr_8rem_1fr] md:grid-rows-[auto_5rem_auto] md:items-center">
            <div className="md:col-start-3 md:row-start-1">
              <DiagramNode number="02" title="SIU" subtitle="the measure" copy="One basket converts any model’s work into one comparable unit." featured />
            </div>

            <Relationship label="measured in" className="md:col-start-2 md:row-start-2 md:rotate-[-28deg]" />
            <Relationship label="priced in" className="md:col-start-4 md:row-start-2 md:rotate-[28deg]" />

            <div className="md:col-start-1 md:row-start-3">
              <DiagramNode number="01" title="Inference" subtitle="the commodity" copy="GPUs and models produce tokens of work." />
            </div>
            <div className="hidden items-center gap-3 md:col-span-3 md:col-start-2 md:row-start-3 md:flex" aria-hidden="true">
              <span className="h-px flex-1 bg-ploy-border-primary" />
              <span className="font-mono text-[0.58rem] uppercase tracking-[0.18em] text-ploy-text-secondary">settles</span>
              <span className="h-px flex-1 bg-ploy-border-primary" />
            </div>
            <div className="md:col-start-5 md:row-start-3">
              <DiagramNode number="03" title="Dollar" subtitle="the settlement" copy="USDC paid over x402 or MPP." />
            </div>
          </div>
          <figcaption id="triangle-caption" className="mt-8 text-center font-mono text-[0.6rem] uppercase tracking-[0.17em] text-ploy-text-secondary md:hidden">Inference settles in dollars · measured and priced through SIU</figcaption>
        </figure>

        <div className="mt-14 grid gap-8 border-t border-ploy-border-primary pt-8 md:grid-cols-2">
          <p id="analogy-title" className="font-heading text-2xl leading-snug">Inference is the commodity, SIU is the grade, and the dollar settles.</p>
          <p className="max-w-xl leading-7 text-ploy-text-secondary">A touchstone is the dark stone used to test the purity of metal by the mark it leaves; an assay is the formal test.</p>
        </div>

        <div className="mt-10 border-t border-ploy-border-primary pt-8" aria-label="Touchstone Assay sits outside the AI-buying stack, connected to it only by measurement">
          <div className="flex flex-wrap items-center justify-center gap-2 font-mono text-[0.56rem] uppercase tracking-[0.16em] text-ploy-text-secondary">
            <StackNode>Routing</StackNode>
            <StackArrow />
            <StackNode>Metering</StackNode>
            <StackArrow />
            <StackNode>Billing</StackNode>
            <StackArrow />
            <StackNode>Settlement</StackNode>
          </div>
          <div className="ml-auto flex w-fit flex-col items-center gap-1 pr-2 md:pr-16">
            <span className="h-5 border-l border-dashed border-ploy-border-primary" aria-hidden="true" />
            <span className="border border-dashed border-ploy-accent-primary px-2 py-1 font-mono text-[0.56rem] uppercase tracking-[0.16em] text-ploy-accent-primary">Touchstone Assay</span>
          </div>
          <p className="mt-2 text-center font-mono text-[0.58rem] uppercase tracking-[0.16em] text-ploy-text-secondary">Measurement sits outside the flow.</p>
        </div>
      </div>
    </section>
  );
}

function StackNode({ children }: { children: ReactNode }) {
  return <span className="border border-ploy-border-primary px-2 py-1">{children}</span>;
}

function StackArrow() {
  return <span aria-hidden="true">&rarr;</span>;
}

function DiagramNode({ number, title, subtitle, copy, featured = false }: { number: string; title: string; subtitle: string; copy: string; featured?: boolean }) {
  return <div className={`border border-ploy-border-primary p-6 text-center ${featured ? "bg-ploy-background-inverse text-ploy-text-inverse" : "bg-ploy-background-primary text-ploy-text-primary"}`}><span className={`font-mono text-[0.62rem] tracking-[0.2em] ${featured ? "text-ploy-text-inverse-secondary" : "text-ploy-text-secondary"}`}>{number}</span><h3 className="mt-7 font-mono text-2xl uppercase tracking-[0.08em]">{title}</h3><p className="mt-1 font-heading italic text-ploy-accent-primary">{subtitle}</p><p className={`mx-auto mt-5 max-w-xs text-sm leading-6 ${featured ? "text-ploy-text-inverse-secondary" : "text-ploy-text-secondary"}`}>{copy}</p></div>;
}

function Relationship({ label, className }: { label: string; className: string }) {
  return <div className={`hidden items-center gap-3 md:flex ${className}`} aria-hidden="true"><span className="h-px flex-1 bg-ploy-border-primary" /><span className="whitespace-nowrap bg-ploy-background-secondary px-2 font-mono text-[0.58rem] uppercase tracking-[0.18em] text-ploy-text-secondary">{label}</span><span className="h-px flex-1 bg-ploy-border-primary" /></div>;
}
