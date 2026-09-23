import { Analogy } from "./sections/analogy";
import { Builders } from "./sections/builders";
import { Footer } from "./sections/footer";
import { Hero } from "./sections/hero";
import { HowItWorks } from "./sections/how-it-works";
import { Method } from "./sections/method";
import { Problem } from "./sections/problem";
import { Proof } from "./sections/proof";
import { Roadmap } from "./sections/roadmap";
import { UnitOfAccount } from "./sections/unit-of-account";

/**
 * @ployComponent
 * @ployComponentId touchstone-home-page
 * @ployComponentType page
 * @ployComponentPattern homepage
 * @ployComponentDescription Single-page institutional publication site for the Dated SIU benchmark.
 * @ployComponentStatus stable
 */
export function HomePage() {
  return (
    <main id="top" className="min-h-screen bg-ploy-background-primary text-ploy-text-primary selection:bg-ploy-accent-primary selection:text-ploy-text-inverse">
      <Hero />
      <Proof />
      <UnitOfAccount />
      <Problem />
      <Analogy />
      <HowItWorks />
      <Method />
      <Builders />
      <Roadmap />
      <Footer />
    </main>
  );
}
