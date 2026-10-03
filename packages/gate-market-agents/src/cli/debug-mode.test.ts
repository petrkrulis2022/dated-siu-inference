import { describe, expect, it } from "vitest";
import {
  DECIDER_SEATS,
  assertCountableForF1,
  disqualification,
  isCountable,
  parseDebugFlags,
  renderDebugBanner,
  runIdPrefix,
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
