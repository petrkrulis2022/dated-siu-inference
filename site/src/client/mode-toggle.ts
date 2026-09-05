/**
 * Sitewide (loaded on every page via layout.ts) — the toggle nav itself is plain server-rendered
 * links (correct on first load with no JS at all: layout.ts marks the active one server-side via
 * aria-current based on which page is being rendered). This script only adds two things JS
 * genuinely needs to do: remember the visitor's last-chosen mode, and point the header wordmark
 * at it, so returning to the wordmark from deep in "For agents" doesn't always bounce back to
 * the human homepage.
 */

const STORAGE_KEY = "touchstone-mode";

function currentMode(): "human" | "for-agents" {
  return document.body.dataset.mode === "for-agents" ? "for-agents" : "human";
}

function main(): void {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const wordmark = document.querySelector<HTMLAnchorElement>(".wordmark");
    if (wordmark && stored === "for-agents") {
      const forAgentsLink = document.querySelector<HTMLAnchorElement>('.mode-toggle a[href*="for-agents"]');
      if (forAgentsLink) wordmark.href = forAgentsLink.getAttribute("href")!.split("#")[0]!;
    }
    window.localStorage.setItem(STORAGE_KEY, currentMode());
  } catch {
    // localStorage unavailable (private mode, blocked) — the toggle's own links already work
    // fine as plain navigation without it; this script only ever adds a convenience on top.
  }
}

main();
