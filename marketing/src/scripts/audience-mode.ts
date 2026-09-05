/**
 * Persists the visitor's last-chosen audience (human vs. for-agents) across page loads, and
 * points the wordmark at it — parity with site/src/client/mode-toggle.ts's own behavior. Deliberately
 * NOT a page-load redirect: server-rendered active state (the `activeMode` prop threaded into
 * <Navbar>/<AudienceToggle>) is already correct for whichever page was actually requested, so this
 * script only needs to (a) remember a click and (b) retarget the wordmark link for next time. Plain
 * vanilla script (not a React island) so it runs on the homepage too, which stays fully static.
 */
const STORAGE_KEY = "touchstone-mode";

function resolveMode(href: string): "human" | "for-agents" | undefined {
  if (href === "/" || href.startsWith("/#")) return "human";
  if (href.startsWith("/for-agents")) return "for-agents";
  return undefined;
}

function init(): void {
  const toggle = document.querySelector(".mode-toggle");
  toggle?.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement).closest("a");
    if (!link) return;
    const mode = resolveMode(link.getAttribute("href") ?? "");
    if (mode) localStorage.setItem(STORAGE_KEY, mode);
  });

  const wordmark = document.querySelector<HTMLAnchorElement>('a[aria-label="Touchstone Assay home"]');
  if (!wordmark) return;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "for-agents") wordmark.setAttribute("href", "/for-agents");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
