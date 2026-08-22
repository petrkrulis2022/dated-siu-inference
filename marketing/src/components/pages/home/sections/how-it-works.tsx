import { DocumentHeader } from "../components/document-header";

const mechanisms = [
  ["The basket", "A fixed, versioned set of inference tasks with objective quality gates. Output that fails the gate prices at zero."],
  ["The exchange rates", "Each model’s cost expressed in SIU, published as spreads to the index, the way crude grades trade at differentials to a benchmark."],
  ["The quote extension", "A touchstone-quote object carried inside an x402 or MPP payment-required response, so an agent can compare offers in one unit before paying."],
] as const;

const basket = [
  ["T1", "0.50", "Short conversational completion", "Reference quality"],
  ["T2", "0.30", "Long-context retrieval and summarisation", "Document-scale"],
  ["T3", "0.20", "Code generation verified by test-pass", "Pass / fail gate"],
] as const;

const stages = [
  ["01", "Execute the basket", "Run each fixed task class at the stated reference quality."],
  ["02", "Measure usage", "Read input, output and reasoning usage from each real run."],
  ["03", "Apply posted prices", "Calculate the observed cost from the provider’s applicable prices."],
  ["04", "Enforce quality", "Failed work prices at zero; retries carry their measured attempt cost."],
  ["05", "Cost each basket", "Weight completed task-class costs under the current basket version."],
  ["06", "Issue the print", "Weight qualifying observations, sign the result and publish the record."],
] as const;

const quoteExample = `HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "accepts": [{
    "scheme": "exact",
    "asset": "USDC",
    "amount": "0.0217"
  }],
  "touchstone-quote": {
    "siu": "1.62",
    "index": "Dated SIU",
    "print": "latest",
    "methodology": "SIU-v1"
  }
}`;

/**
 * @ployComponent
 * @ployComponentId touchstone-how-it-works
 * @ployComponentType section
 * @ployComponentPattern process
 * @ployComponentDescription SIU basket, calculation sequence, exchange-rate and quote-extension mechanics.
 * @ployComponentStatus stable
 */
export function HowItWorks() {
  return (
    <section className="how-it-works mx-auto max-w-7xl px-5 py-20 md:px-8 md:py-28" aria-labelledby="how-title">
      <DocumentHeader label="How it works" title="One standard, three layers." />
      <div className="mt-14 grid gap-px border border-ploy-border-primary bg-ploy-border-primary md:grid-cols-3">
        {mechanisms.map(([title, copy], index) => <article key={title} className="bg-ploy-background-primary p-6 md:min-h-72 md:p-8"><span className="font-mono text-[0.62rem] tracking-[0.2em] text-ploy-text-secondary">0{index + 1}</span><h3 className="mt-12 font-heading text-3xl font-normal">{title}</h3><p className="mt-5 text-sm leading-6 text-ploy-text-secondary">{copy}</p></article>)}
      </div>

      <figure className="mt-16 border-y border-ploy-border-primary py-8">
        <figcaption className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div><p className="font-mono text-[0.62rem] uppercase tracking-[0.2em] text-ploy-text-secondary">Index methodology</p><h3 className="mt-3 font-heading text-3xl font-normal md:text-4xl">How one Dated SIU print is calculated</h3></div>
          <span className="w-fit border border-ploy-accent-primary px-2 py-1 font-mono text-[0.58rem] uppercase tracking-[0.16em] text-ploy-accent-primary">All figures illustrative</span>
        </figcaption>

        <div className="mt-9">
          <div className="flex items-center justify-between gap-4 border-b border-ploy-border-primary pb-3 font-mono text-[0.58rem] uppercase tracking-[0.16em] text-ploy-text-secondary"><span>Stage 01 · The basket</span><span>Fixed · versioned</span></div>
          <div className="grid gap-px bg-ploy-border-primary md:grid-cols-3">
            {basket.map(([task, weight, name, gate]) => <div key={task} className="bg-ploy-background-primary p-5"><div className="flex justify-between font-mono text-sm"><span>{task}</span><span className="text-ploy-accent-primary">{weight}</span></div><p className="mt-6 font-heading text-lg">{name}</p><p className="mt-3 font-mono text-[0.56rem] uppercase tracking-[0.15em] text-ploy-text-secondary">{gate}</p></div>)}
          </div>
          <p className="border-x border-b border-ploy-border-primary p-5 text-sm leading-6 text-ploy-text-secondary">One SIU is one execution of the weighted basket at reference quality.</p>
        </div>

        <ol className="mt-9 grid gap-px border border-ploy-border-primary bg-ploy-border-primary md:grid-cols-3">
          {stages.map(([number, title, copy]) => <li key={number} className="bg-ploy-background-secondary p-5"><span className="font-mono text-[0.6rem] text-ploy-accent-primary">{number}</span><h4 className="mt-5 font-heading text-xl font-normal">{title}</h4><p className="mt-3 text-xs leading-5 text-ploy-text-secondary">{copy}</p></li>)}
        </ol>
        <div className="mt-px grid bg-ploy-background-inverse px-6 py-8 text-ploy-text-inverse md:grid-cols-12 md:items-end md:px-8">
          <p className="font-mono text-[0.6rem] uppercase tracking-[0.18em] text-ploy-text-inverse-secondary md:col-span-5">Dated SIU · signed · hash-anchored print</p>
          <p className="mt-5 font-mono text-4xl tabular-nums md:col-span-7 md:mt-0 md:text-right">ISSUED</p>
        </div>
      </figure>

      <div className="mt-16 grid gap-8 md:grid-cols-12">
        <div className="md:col-span-4"><p id="how-title" className="font-heading text-2xl leading-snug">The quote travels with the payment request.</p><p className="mt-5 text-sm leading-6 text-ploy-text-secondary">The example is illustrative. Fields and version identifiers explain the transport pattern, not a production schema commitment.</p></div>
        <figure className="md:col-span-8"><figcaption className="mb-3 font-mono text-[0.62rem] uppercase tracking-[0.18em] text-ploy-text-secondary">Annotated HTTP 402 · illustrative</figcaption><pre className="overflow-x-auto bg-ploy-background-inverse p-5 font-mono text-[0.7rem] leading-6 text-ploy-text-inverse md:p-8"><code>{quoteExample}</code></pre></figure>
      </div>
    </section>
  );
}
