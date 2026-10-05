import { describe, expect, it } from "vitest";
import { PRICES } from "./p5-shared.js";
import { DEFAULT_CHEAP_MODEL } from "./debug-mode.js";
import {
  DECIDER_SEATS,
  assertCountableForF1,
  disqualification,
  isCountable,
  parseDebugFlags,
  renderDebugBanner,
  runIdPrefix,
  rosterCollapse,
  renderRosterCollapse,
  PRODUCTION_RUN,
} from "./debug-mode.js";

describe("--debug", () => {
  it("defaults to the canonical three windows, with or without --debug", () => {
    // Deliberate, and the one default worth defending: three of the last four findings came
    // from window 2 or later — the wait primitive's blind spot, the holder never being woken,
    // and whether a held claim gets used. A one-window default would have hidden all three
    // while looking like a saving.
    expect(parseDebugFlags([]).windows).toBe(3);
    expect(parseDebugFlags(["--debug"]).windows).toBe(3);
    expect(parseDebugFlags(["--debug", "--windows", "1"]).windows).toBe(1);
  });

  it("refuses a nonsense window count rather than silently running three", () => {
    expect(() => parseDebugFlags(["--windows", "0"])).toThrow(/positive integer/);
    expect(() => parseDebugFlags(["--windows", "two"])).toThrow(/positive integer/);
    expect(() => parseDebugFlags(["--windows"])).toThrow(/positive integer/);
  });

  it("changes nothing at all unless --debug is passed", () => {
    const cfg = parseDebugFlags([]);
    expect(cfg).toEqual(PRODUCTION_RUN);
    expect(cfg.preAuthoredGate).toBe(false);
    expect(cfg.cheapNonDeciders).toBe(false);
    expect(isCountable(cfg)).toBe(true);
    expect(disqualification(cfg)).toBeNull();
  });

  it("each saving can be switched off on its own", () => {
    expect(parseDebugFlags(["--debug", "--no-pre-authored-gate"]).preAuthoredGate).toBe(false);
    expect(parseDebugFlags(["--debug", "--no-cheap-models"]).cheapNonDeciders).toBe(false);
  });

  it("keeps the deciders on their assigned models — a cheaper decider is a different decider", () => {
    // F1 is a question about what these two seats choose, and every holder-facing finding so
    // far has come from WORKER-CODE. Substituting either would change the behaviour being
    // debugged into some other behaviour.
    expect(DECIDER_SEATS).toContain("ORCHESTRATOR");
    expect(DECIDER_SEATS).toContain("WORKER-CODE");
    expect(DECIDER_SEATS).not.toContain("ISSUER-A");
    expect(DECIDER_SEATS).not.toContain("WORKER-EXTRACT");
  });

  it("disqualifies a debug run, and says which savings did it", () => {
    const why = disqualification(parseDebugFlags(["--debug"]));
    expect(why).toMatch(/gate was pinned/);
    expect(why).toMatch(/non-decider seats ran on/);
    expect(isCountable(parseDebugFlags(["--debug"]))).toBe(false);
  });

  it("disqualifies a SHORTENED run even without --debug — length is a comparability change too", () => {
    const cfg = parseDebugFlags(["--windows", "1"]);
    expect(cfg.enabled).toBe(false);
    expect(isCountable(cfg)).toBe(false);
    expect(disqualification(cfg)).toMatch(/1 window\(s\) rather than the canonical 3/);
  });

  it("disqualifies --debug even with every saving switched off", () => {
    // Asking for a debug run and getting a countable one would be the worst outcome: the
    // operator believes it does not count and the artefact says it does.
    const cfg = parseDebugFlags(["--debug", "--no-pre-authored-gate", "--no-cheap-models"]);
    expect(isCountable(cfg)).toBe(false);
    expect(disqualification(cfg)).toMatch(/--debug was set/);
  });

  it("assertCountableForF1 THROWS on a debug run — the guard is code, not convention", () => {
    expect(() =>
      assertCountableForF1({
        runId: "DEBUG-p5-three-window-x",
        debugMode: { disqualifiedBecause: "the gate was pinned rather than authored" },
      }),
    ).toThrow(/cannot count toward F1 or meet the bar/);
  });

  it("assertCountableForF1 passes a real run through untouched", () => {
    expect(() =>
      assertCountableForF1({
        runId: "p5-three-window-x",
        debugMode: { disqualifiedBecause: null },
      }),
    ).not.toThrow();
    expect(() => assertCountableForF1({ runId: "p5-three-window-x" })).not.toThrow();
  });

  it("names a debug run's artefacts so they cannot be mistaken in a directory listing", () => {
    expect(runIdPrefix(parseDebugFlags(["--debug"]))).toBe("DEBUG-p5-three-window");
    expect(runIdPrefix(parseDebugFlags(["--windows", "2"]))).toBe("DEBUG-p5-three-window");
    expect(runIdPrefix(parseDebugFlags([]))).toBe("p5-three-window");
  });

  it("says in its banner that it cannot meet the bar, before anything is spent", () => {
    const banner = renderDebugBanner(parseDebugFlags(["--debug"]));
    expect(banner).toMatch(/CANNOT MEET THE BAR OR COUNT TOWARD F1/);
    expect(banner).toMatch(/Disqualified because/);
    // And is honest about what IS still real, so nobody discounts the parts that count.
    expect(banner).toMatch(/Every economic step is still real/);
  });

  it("a canonical run's banner claims nothing and warns about nothing", () => {
    const banner = renderDebugBanner(parseDebugFlags([]));
    expect(banner).toMatch(/canonical/);
    expect(banner).not.toMatch(/CANNOT MEET THE BAR/);
  });
});

describe("--scripted and --window-seconds — the walk that exercises fSIU without a model deciding", () => {
  it("is off, and windows are the production 2400 seconds, unless asked otherwise", () => {
    const cfg = parseDebugFlags(["--debug"]);
    expect(cfg.scripted).toBe(false);
    expect(cfg.windowSeconds).toBe(2400);
    expect(PRODUCTION_RUN.scripted).toBe(false);
    expect(PRODUCTION_RUN.windowSeconds).toBe(2400);
  });

  it("REQUIRES --debug: a run in which no model decides anything can never count", () => {
    expect(() => parseDebugFlags(["--scripted"])).toThrow(/--scripted requires --debug/);
    expect(parseDebugFlags(["--debug", "--scripted"]).scripted).toBe(true);
  });

  it("is disqualified in its own words — no model was called", () => {
    const cfg = parseDebugFlags(["--debug", "--scripted"]);
    expect(isCountable(cfg)).toBe(false);
    expect(disqualification(cfg)).toMatch(/no model was called: every seat followed a fixed script/);
    expect(renderDebugBanner(cfg)).toMatch(/SCRIPTED/);
  });

  it("takes a window length, and refuses one too short for a quote to live in", () => {
    expect(parseDebugFlags(["--debug", "--scripted", "--window-seconds", "180"]).windowSeconds).toBe(180);
    for (const bad of ["abc", "0", "-5", "29", "1.5", ""]) {
      expect(() => parseDebugFlags(["--debug", "--window-seconds", bad]), bad).toThrow(/--window-seconds expects/);
    }
  });

  it("disqualifies a run with shortened windows even without --debug — length is a comparability change too", () => {
    const cfg = parseDebugFlags(["--window-seconds", "600"]);
    expect(cfg.enabled).toBe(false);
    expect(isCountable(cfg)).toBe(false);
    expect(disqualification(cfg)).toMatch(/windows lasted 600 seconds rather than the canonical 2400/);
    expect(runIdPrefix(cfg)).toBe("DEBUG-p5-three-window");
  });

  it("states the window length in a debug banner, so a short run cannot be read as a production one", () => {
    expect(renderDebugBanner(parseDebugFlags(["--debug", "--window-seconds", "240"]))).toMatch(/window length\s+240s/);
  });
});

describe("roster collapse — a debug run does not validate the block's roster", () => {
  const PROVIDER: Record<string, string> = {
    "claude-sonnet-5": "anthropic",
    "gpt-5.1": "openai",
    "gemini-3.1-pro-preview": "google",
    "grok-4.6": "xai",
    "claude-haiku-4-5": "anthropic",
  };
  const providerOf = (m: string) => PROVIDER[m] ?? "unknown";
  const assigned = {
    ORCHESTRATOR: "gpt-5.1",
    "WORKER-CODE": "claude-sonnet-5",
    "WORKER-EXTRACT": "gemini-3.1-pro-preview",
    "ISSUER-A": "grok-4.6",
    "ISSUER-B": "grok-4.6",
  };

  it("names exactly the providers a substituted run stops calling", () => {
    const substituted = {
      ...assigned,
      "WORKER-EXTRACT": "claude-haiku-4-5",
      "ISSUER-A": "claude-haiku-4-5",
      "ISSUER-B": "claude-haiku-4-5",
    };
    const c = rosterCollapse(assigned, substituted, providerOf);
    expect(c.exercised).toEqual(["anthropic", "openai"]);
    expect(c.dropped).toEqual(["google", "xai"]);
  });

  it("reports no collapse when every provider still runs", () => {
    const c = rosterCollapse(assigned, assigned, providerOf);
    expect(c.dropped).toEqual([]);
    expect(renderRosterCollapse(c)).toBe("");
  });

  it("reports no collapse when a substitution leaves another seat on the same provider", () => {
    // Two seats share grok. Moving one of them does not remove xai from the run, and claiming
    // it did would overstate the collapse as readily as missing it would understate it.
    const c = rosterCollapse(assigned, { ...assigned, "ISSUER-A": "claude-haiku-4-5" }, providerOf);
    expect(c.dropped).toEqual([]);
    expect(c.exercised).toContain("xai");
  });

  it("says plainly that a green run here is not roster validation", () => {
    // The failure this guards against is somebody reading a clean debug run as evidence the
    // block's roster is sound. grok truncating mid-JSON and gemini returning only reasoning
    // tokens both ended real runs, and neither is reachable when neither model is called.
    // Both grok seats must move before xai leaves the run — substituting one of two changes
    // nothing, which the previous version of this fixture got wrong.
    const text = renderRosterCollapse(
      rosterCollapse(
        assigned,
        { ...assigned, "ISSUER-A": "claude-haiku-4-5", "ISSUER-B": "claude-haiku-4-5" },
        providerOf,
      ),
    );
    expect(text).toMatch(/DOES NOT VALIDATE THE BLOCK'S ROSTER/);
    expect(text).toMatch(/full-cost run is what proves the roster/);
    expect(text).toMatch(/required before any freeze/);
  });
});


describe("the cheap model is usable at all", () => {
  it("has a price, or every substituted seat crashes mid-turn", () => {
    // Run 2026-10-03T14-28 died exactly here: claude-haiku-4-5 had no PRICES entry, so
    // projectedTurnCostUsd threw 256 seconds into the first substituted agent's turn, after
    // $0.38 of real spend. TypeScript cannot catch it — indexing a Record<string, T> is typed
    // as present — and the projection is what the run cap is enforced against, so an absent
    // price means a run with no ceiling rather than a run that stops.
    const price = PRICES[DEFAULT_CHEAP_MODEL];
    expect(price, `no PRICES entry for ${DEFAULT_CHEAP_MODEL}`).toBeDefined();
    expect(Number(price?.priceInUsdPer1M)).toBeGreaterThan(0);
    expect(Number(price?.priceOutUsdPer1M)).toBeGreaterThan(0);
  });

  it("is actually cheaper than the frontier seats it replaces", () => {
    // A "cheap" model that is not cheaper would make --debug a pure downside: same cost, worse
    // behaviour, disqualified result.
    const cheap = Number(PRICES[DEFAULT_CHEAP_MODEL]?.priceOutUsdPer1M);
    for (const frontier of ["claude-sonnet-5", "gpt-5.1", "gemini-3.1-pro-preview", "grok-4.6"]) {
      expect(cheap, `${DEFAULT_CHEAP_MODEL} is not cheaper than ${frontier}`).toBeLessThan(
        Number(PRICES[frontier]?.priceOutUsdPer1M),
      );
    }
  });
});
