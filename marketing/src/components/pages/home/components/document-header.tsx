type DocumentHeaderProps = {
  label: string;
  title: string;
  copy?: string;
};

/**
 * @ployComponent
 * @ployComponentId touchstone-document-header
 * @ployComponentType component
 * @ployComponentPattern heading
 * @ployComponentDescription Editorial section heading for Touchstone Assay publication pages.
 * @ployComponentStatus stable
 */
export function DocumentHeader({ label, title, copy }: DocumentHeaderProps) {
  return (
    <header className="document-header grid gap-5 border-t border-ploy-border-primary pt-5 md:grid-cols-12 md:gap-8">
      <p className="document-header__label font-mono text-[0.68rem] uppercase tracking-[0.22em] text-ploy-text-secondary md:col-span-3">{label}</p>
      <div className="md:col-span-9 md:grid md:grid-cols-9 md:gap-8">
        <h2 className="document-header__title text-balance font-heading text-3xl font-normal leading-[1.05] md:col-span-5 md:text-5xl">{title}</h2>
        {copy ? <p className="document-header__copy mt-4 max-w-xl text-[1.02rem] leading-7 text-ploy-text-secondary md:col-span-4 md:mt-1">{copy}</p> : null}
      </div>
    </header>
  );
}
