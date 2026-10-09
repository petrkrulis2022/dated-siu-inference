import { describe, expect, it } from "vitest";
import { AMENDED_LABEL, FROZEN_LABEL, agreementReport, type TaggedReason } from "./tag-agreement.js";

const r = (id: string, text: string, over: Partial<TaggedReason> = {}): TaggedReason => ({ id, text, categories: [], affordabilityOnly: false, noneOfThese: false, ...over });

const AFFORD = "I have sufficient USDC (6,639 minor units) to cover the cost of this quote.";
const EARMARK = "Paying with fSIU preserves USDC for raw work purchases.";
const SEQUENCE = "I need TYPE-2 now, then raw work, so I can deliver.";
const RELATIVE = "I hold more fSIU than USDC, so I spend the larger holding.";

describe("agreementReport", () => {
  const reasons: TaggedReason[] = [
    r("a", AFFORD, { affordabilityOnly: true }),
    r("b", AFFORD + " Paying with fSIU preserves USDC for raw work.", { affordabilityOnly: true, categories: ["earmarking"] }),
    r("c", EARMARK, { categories: ["earmarking"] }),
    r("d", SEQUENCE),
    r("e", RELATIVE, { categories: ["balance_size"] }),
  ];
  const report = agreementReport(reasons);

  it("counts, per category and per coding, where the person and the rules agree", () => {
    expect(report.reasons).toBe(5);
    const earmarking = (c: typeof report.frozen) => c.perCategory.find((x) => x.category === "earmarking")!;
    expect(earmarking(report.frozen)).toMatchObject({ both: 2, humanOnly: 0, ruleOnly: 0, neither: 3, agreementPercent: 100 });
    expect(earmarking(report.amended)).toMatchObject({ both: 2, neither: 3 });
  });

  it("labels the frozen coding primary and the amended coding exploratory, and keeps them apart", () => {
    expect(report.frozen.label).toBe(FROZEN_LABEL);
    expect(report.amended.label).toBe(AMENDED_LABEL);
    expect(report.amended.label).toMatch(/exploratory/);
    expect(report.frozen.label).toMatch(/primary/);
  });

  it("differs between the codings on category 3 exactly where a remark is only about being able to pay", () => {
    const three = (c: typeof report.frozen) => c.perCategory.find((x) => x.category === "balance_size")!;
    // Frozen: 'sufficient' fires 3 on a, b and the relative one e. The person ticked 3 only on e.
    expect(three(report.frozen)).toMatchObject({ both: 1, humanOnly: 0, ruleOnly: 2 });
    // Amended: only e is 3.
    expect(three(report.amended)).toMatchObject({ both: 1, humanOnly: 0, ruleOnly: 0 });
  });

  it("maps box A onto both codings and does not fold it into 3 or 9", () => {
    const a = report.affordability;
    expect(a.ticked).toBe(2);
    expect(a.frozen).toMatchObject({ label: FROZEN_LABEL, inCategory3: 2, inCategory9: 0, inOtherCategoriesOnly: 0 });
    expect(a.amended).toMatchObject({ label: AMENDED_LABEL, affordabilityFired: 2, relativeFired: 0, inCategory3: 0, inCategory9: 1 });
    expect(a.notTickedButAffordabilityFired).toBe(0);
  });

  it("reports an affordability reading that fires on a reason the person did not tick A for", () => {
    const rep = agreementReport([r("x", AFFORD), r("y", SEQUENCE)]);
    expect(rep.affordability.notTickedButAffordabilityFired).toBe(1);
    expect(rep.affordability.ticked).toBe(0);
  });

  it("counts 'none of these' and gives percentages as whole numbers", () => {
    const rep = agreementReport([r("n", "Something odd.", { noneOfThese: true }), r("m", EARMARK, { categories: ["earmarking"] }), r("o", SEQUENCE, { categories: [] })]);
    expect(rep.noneOfThese).toBe(1);
    for (const c of rep.frozen.perCategory) expect(Number.isInteger(c.agreementPercent)).toBe(true);
  });
});
