import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * @ployComponent
 * @ployComponentId touchstone-audience-toggle
 * @ployComponentType component
 * @ployComponentPattern segmented-control
 * @ployComponentDescription Human / For agents / Try it here — an audience switch, not three peer options.
 * @ployComponentStatus stable
 */

/**
 * Purely presentational — no hooks, no client-side state. `activeMode` is threaded down from
 * whichever .astro page mounts this (index.astro passes "human", for-agents.astro passes
 * "for-agents") so the correct link is server-rendered as active with zero JavaScript, exactly
 * like site/'s own layout.ts toggle. "For agents" and "Try it here" are NOT two audiences next
 * to "Human" — "Try it here" is a connection *method* nested under the agent path (an in-browser
 * demo of the same MCP tools), so it never gets its own active state distinct from "For agents";
 * both point at /for-agents, the second with a same-page anchor.
 */
const toggleLinkVariants = cva(
  "border px-3 py-1 font-mono text-[0.65rem] uppercase tracking-[0.1em] transition-colors",
  {
    variants: {
      active: {
        true: "border-ploy-border-primary text-ploy-text-primary font-semibold",
        false:
          "border-ploy-border-primary/40 text-ploy-text-secondary hover:border-ploy-border-primary hover:text-ploy-text-primary",
      },
    },
    defaultVariants: { active: false },
  },
);

export interface AudienceToggleProps {
  activeMode: "human" | "for-agents";
}

export function AudienceToggle({ activeMode }: AudienceToggleProps) {
  const forAgentsActive = activeMode === "for-agents";
  return (
    <div className="mode-toggle flex items-center gap-2" aria-label="Audience">
      <a
        href="/"
        className={cn(toggleLinkVariants({ active: !forAgentsActive }))}
        aria-current={forAgentsActive ? undefined : "page"}
      >
        Human
      </a>
      <a
        href="/for-agents"
        className={cn(toggleLinkVariants({ active: forAgentsActive }))}
        aria-current={forAgentsActive ? "page" : undefined}
      >
        For agents
      </a>
      <a
        href="/for-agents#try-it-here"
        className={cn(toggleLinkVariants({ active: false }))}
        title="Live, in-browser tools — a connection method, not a third audience"
      >
        Try it here
      </a>
    </div>
  );
}
