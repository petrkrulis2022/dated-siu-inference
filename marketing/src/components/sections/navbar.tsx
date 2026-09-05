import { PUBLICATION_URL } from "../pages/home/content";
import { AudienceToggle } from "./audience-toggle";

/**
 * @ployComponent
 * @ployComponentId touchstone-navbar
 * @ployComponentType section
 * @ployComponentPattern navbar
 * @ployComponentDescription Site-wide header: wordmark, primary nav, and the audience toggle.
 * @ployComponentStatus stable
 */

/**
 * Extracted from hero.tsx's own inline header once /for-agents became this site's second
 * consumer of it — per this project's own promotion-ladder rule (AGENTS.md), two consumers is
 * the condition for promoting to shared code, not a reason to defer it. The homepage's ticker
 * bar (Dated SIU value / settlement / print cadence) stays in Hero — that's homepage content,
 * not site chrome. Every anchor-only link here is now homepage-qualified ("/#method", not
 * "#method"), since a bare fragment would just scroll nowhere on any page other than "/".
 */
export interface NavbarProps {
  activeMode: "human" | "for-agents";
}

export function Navbar({ activeMode }: NavbarProps) {
  return (
    <div className="mx-auto max-w-7xl px-5 pt-7 md:px-8 md:pt-10">
      <nav
        className="hero__nav flex flex-wrap items-center justify-between gap-4 border-b border-ploy-border-primary pb-7"
        aria-label="Primary navigation"
      >
        <a href="/#top" className="group flex min-w-0 items-center gap-3" aria-label="Touchstone Assay home">
          <img src="/logo.png" alt="" width={32} height={32} className="size-8 shrink-0 rounded-md" />
          <span className="min-w-0">
            <span className="block truncate font-heading text-xl tracking-[0.04em] md:text-2xl">TOUCHSTONE ASSAY</span>
            <span className="block truncate font-mono text-[0.5rem] uppercase tracking-[0.26em] text-ploy-text-secondary">AI inference index &amp; pricing</span>
          </span>
        </a>
        <div className="hidden items-center gap-7 font-mono text-[0.65rem] uppercase tracking-[0.13em] md:flex">
          <a href="/#method" className="hover:text-ploy-accent-primary">Method</a>
          <a href="/#builders" className="hover:text-ploy-accent-primary">For builders</a>
          <a href={PUBLICATION_URL} className="border-b border-current pb-1 hover:text-ploy-accent-primary">Full series</a>
        </div>
        <AudienceToggle activeMode={activeMode} />
      </nav>
    </div>
  );
}
