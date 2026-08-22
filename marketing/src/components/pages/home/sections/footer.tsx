/**
 * @ployComponent
 * @ployComponentId touchstone-footer
 * @ployComponentType section
 * @ployComponentPattern footer
 * @ployComponentDescription Legal and contact footer for Touchstone Assay.
 * @ployComponentStatus stable
 */
export function Footer() {
  return (
    <footer className="footer bg-ploy-background-inverse text-ploy-text-inverse">
      <div className="mx-auto max-w-7xl px-5 py-12 md:px-8 md:py-16">
        <div className="grid gap-10 border-t border-ploy-border-inverse pt-7 md:grid-cols-12">
          <div className="md:col-span-5"><p className="font-heading text-2xl tracking-[0.04em]">TOUCHSTONE ASSAY</p><p className="mt-2 font-mono text-[0.58rem] uppercase tracking-[0.2em] text-ploy-text-inverse-secondary">Verified, not surveyed</p></div>
          <div className="flex gap-6 font-mono text-xs md:col-span-3"><a href="mailto:contact@touchstoneassay.com" className="hover:text-ploy-accent-primary">Contact</a><a href="#" className="hover:text-ploy-accent-primary">GitHub</a></div>
          <p className="text-sm leading-6 text-ploy-text-inverse-secondary md:col-span-4">SIU is a measurement standard and data publication. Nothing on this site is an offer of any token, security or investment.</p>
        </div>
        <p className="mt-12 font-mono text-[0.58rem] uppercase tracking-[0.16em] text-ploy-text-inverse-secondary">© {new Date().getFullYear()} Touchstone Assay</p>
      </div>
    </footer>
  );
}
