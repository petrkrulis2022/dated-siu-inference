/**
 * `--debug`: make a run cheap enough to iterate on, without making it a different experiment.
 *
 * Run 16 cost $3.07 and run 17 $1.77, and almost all of it was gate authoring — run 16's
 * WORKER-CODE turns alone exceeded $0.90, with single turns at $0.474 and $0.277. A debugging
 * run exists to test whether the LOOP works: whether a buyer can buy, a claim can be presented,
 * an issuer can serve, a holder can be told, a default can be settled. None of that needs a
 * model to freshly author a hardened gate, and run 16 spent $3 on three windows to surface a
 * classifier bug a unit test catches for free.
 *
 * What it must never do is produce a number anyone quotes. Every cost saving here changes
 * something the experiment measures — the gate is pinned rather than authored, seats run on
 * cheaper models — so a debug run is disqualified **in code**, not by convention, and says so
 * in its own banner, its runId, its manifest and its report.
 */
import type { AgentId } from "../identity/resolve.js";
import { KNOWN_GOOD_GATE_PROVENANCE } from "./known-good-gate.js";

/**
 * The seats whose choices F1 is about. They keep their assigned models under `--debug` — a
 * cheaper decider is a different decider, and the one thing a debugging run still has to
 * reproduce is the behaviour being debugged.
 *
 * ORCHESTRATOR buys the gate-authoring job. WORKER-CODE is the window's second buyer (it buys
 * adversarial testing) and the holder every holder-facing finding has come from.
 */
export const DECIDER_SEATS: readonly AgentId[] = ["ORCHESTRATOR", "WORKER-CODE"];

/** Registered in `data/registry/models.json`; a seat that only has to exercise a loop does not
 *  need frontier reasoning to do it. */
export const DEFAULT_CHEAP_MODEL = "claude-haiku-4-5";

export interface DebugConfig {
  enabled: boolean;
  /** Windows to run. **Three by default, debug or not** — see `parseDebugFlags`. */
  windows: number;
  /** Inject the pinned known-good gate at window start instead of buying one. */
  preAuthoredGate: boolean;
  /** Run the non-decider seats on `cheapModel`. Deciders are never affected. */
  cheapNonDeciders: boolean;
  cheapModel: string;
}

export const PRODUCTION_RUN: DebugConfig = {
  enabled: false,
  windows: 3,
  preAuthoredGate: false,
  cheapNonDeciders: false,
  cheapModel: DEFAULT_CHEAP_MODEL,
};

/**
 * `--debug`, `--windows N`, `--no-pre-authored-gate`, `--no-cheap-models`.
 *
 * **`--windows` defaults to three whether or not `--debug` is set**, and that is deliberate
 * rather than an oversight: three of the last four findings came from window 2 or later — the
 * wait primitive's blind spot, the holder never being woken, and whether a held claim is ever
 * used. A one-window default would have hidden all three while appearing to save money. Short
 * runs are available for tests that genuinely only need window 1; they are not the default.
 */
export function parseDebugFlags(argv: readonly string[], defaultWindows = 3): DebugConfig {
  const enabled = argv.includes("--debug");
  const at = argv.indexOf("--windows");
  let windows = defaultWindows;
  if (at !== -1) {
    const raw = argv[at + 1];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`--windows expects a positive integer, got ${JSON.stringify(raw)}.`);
    }
    windows = n;
  }
  return {
    enabled,
    windows,
    preAuthoredGate: enabled && !argv.includes("--no-pre-authored-gate"),
    cheapNonDeciders: enabled && !argv.includes("--no-cheap-models"),
    cheapModel: DEFAULT_CHEAP_MODEL,
  };
}

/** `--windows` applies to a production run too, so a shortened production run is still not a
 *  comparable one. Anything that is not the canonical three-window shape is disqualified. */
export function isCountable(cfg: DebugConfig, canonicalWindows = 3): boolean {
  return !cfg.enabled && cfg.windows === canonicalWindows;
}

/** Why this run cannot be quoted, in words, or null when it can. */
export function disqualification(cfg: DebugConfig, canonicalWindows = 3): string | null {
  const reasons: string[] = [];
  if (cfg.preAuthoredGate) reasons.push("the gate was pinned rather than authored");
  if (cfg.cheapNonDeciders) {
    reasons.push(`non-decider seats ran on ${cfg.cheapModel} rather than their assigned models`);
  }
  if (cfg.enabled && reasons.length === 0) reasons.push("--debug was set");
  if (cfg.windows !== canonicalWindows) {
    reasons.push(`it ran ${cfg.windows} window(s) rather than the canonical ${canonicalWindows}`);
  }
  return reasons.length === 0 ? null : reasons.join("; ");
}

/**
 * The guard the instruction "assert in code, not by convention" asks for.
 *
 * Call it anywhere a run's numbers are about to be treated as evidence — an F1 aggregation, a
 * published caption, a verdict quoted outside its own report. It throws rather than warns,
 * because a warning in a log is exactly the convention this replaces.
 */
export function assertCountableForF1(run: {
  runId: string;
  debugMode?: { disqualifiedBecause?: string | null } | undefined;
}): void {
  const why = run.debugMode?.disqualifiedBecause;
  if (why) {
    throw new Error(
      `${run.runId} cannot count toward F1 or meet the bar: ${why}. ` +
        "Run it without --debug and at the canonical window count.",
    );
  }
}

/** A debug run's artefacts are named so they cannot be mistaken for a real one's at a glance,
 *  in a directory listing, or in a glob someone writes months from now. */
export function runIdPrefix(cfg: DebugConfig, canonicalWindows = 3): string {
  return isCountable(cfg, canonicalWindows) ? "p5-three-window" : "DEBUG-p5-three-window";
}

/** Printed before anything is spent, so the log says what this run was. */
export function renderDebugBanner(cfg: DebugConfig, canonicalWindows = 3): string {
  const why = disqualification(cfg, canonicalWindows);
  if (why === null) {
    return `Run shape: canonical — ${cfg.windows} windows, gates authored live, assigned models.`;
  }
  return [
    "=== DEBUG RUN — THIS RUN CANNOT MEET THE BAR OR COUNT TOWARD F1 ===",
    `  Disqualified because: ${why}.`,
    `  windows                 ${cfg.windows}`,
    `  gate                    ${cfg.preAuthoredGate ? `PINNED (${KNOWN_GOOD_GATE_PROVENANCE})` : "authored live"}`,
    `  non-decider seats       ${cfg.cheapNonDeciders ? cfg.cheapModel : "assigned models"}`,
    `  decider seats           ${DECIDER_SEATS.join(", ")} — always their assigned models, so the`,
    "                          behaviour being debugged is the behaviour that runs.",
    "  Every economic step is still real: real chain, real payments, real settlement.",
    "  What is not real is the price of the work and who authored it.",
  ].join("\n");
}
