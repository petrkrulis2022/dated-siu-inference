import { describe, expect, it } from "vitest";
import { EXPECTED, PROBE_QUESTION_1, PROBE_QUESTION_2, PROBE_SUFFIX, buildProbeScreen, judge, parseProbeAnswer } from "./probe.js";

describe("the comprehension probe (D54)", () => {
  const screen = buildProbeScreen();

  it("shows the real v8 screens: the brief, a print that moved up, a quote in SIU, and the trader's holdings in both assets", () => {
    expect(screen.prompt.replace(/\s+/g, " ")).toContain("A job's price is 1.2 SIU");
    expect(screen.prompt).toContain("(up 15.0% on round 1)");
    expect(screen.prompt).toMatch(/qr-1: TYPE-\d job from TRADER-\d, 1 SIU of work, price 1\.2 SIU — settle .*1,200 mSIU of fSIU/);
    expect(screen.prompt).toContain("YOU HOLD: ");
    expect(screen.prompt.replace(/\s+/g, " ")).toContain("Valued at the current print, converting between the two assets changes nothing about your result");
    expect(Number(screen.printByRound[1])).toBeGreaterThan(Number(screen.printByRound[0]));
  });

  it("asks the two questions in the user's words and never which asset a model would choose", () => {
    expect(PROBE_SUFFIX).toContain(PROBE_QUESTION_1);
    expect(PROBE_SUFFIX).toContain(PROBE_QUESTION_2);
    expect(PROBE_QUESTION_1).toBe("If the print rises 15%, does one unit of raw work cost more, fewer or the same USDC? And fSIU?");
    expect(PROBE_QUESTION_2).toBe("Does a quote's price change after it is issued?");
    expect(PROBE_SUFFIX).not.toMatch(/\b(prefer|choose|would you pay|which asset|should)\b/i);
  });

  it("expects USDC more and fSIU the same when the print rises, and a quote that does not change", () => {
    expect(EXPECTED).toEqual({ usdc: "more", fsiu: "same", quoteChanges: "no" });
  });

  it("reads only the enumerated choices, in a reply with a fence or words around it", () => {
    const reply = 'Here you go:\n```json\n{"print_up_15_percent": {"usdc": "More", "fsiu": "same"}, "quote_price_changes_after_issue": "no"}\n```';
    expect(parseProbeAnswer(reply)).toEqual({ usdc: "more", fsiu: "same", quoteChanges: "no" });
    expect(parseProbeAnswer('{"print_up_15_percent": {"usdc": "higher", "fsiu": "same"}}')).toEqual({ fsiu: "same" });
    expect(parseProbeAnswer("I think more")).toEqual({});
    expect(parseProbeAnswer("{not json}")).toEqual({});
  });

  it("judges the print direction wrong unless both parts are right, and an unanswered part is wrong", () => {
    expect(judge({ usdc: "more", fsiu: "same", quoteChanges: "no" })).toEqual({ printDirectionRight: true, quoteRight: true });
    expect(judge({ usdc: "more", fsiu: "more", quoteChanges: "no" }).printDirectionRight).toBe(false);
    expect(judge({ usdc: "fewer", fsiu: "same" }).printDirectionRight).toBe(false);
    expect(judge({ usdc: "more" }).printDirectionRight).toBe(false);
    expect(judge({ usdc: "more", fsiu: "same", quoteChanges: "yes" })).toEqual({ printDirectionRight: true, quoteRight: false });
  });
});
