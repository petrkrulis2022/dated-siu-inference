import { describe, expect, it } from "vitest";
import { PRACTICE_SAMPLE_SIZE, TAGGING_TITLE, TAG_MEANINGS, TAG_SAMPLE_SIZE, drawTagSample, renderTaggingPage, type TagSource } from "./tagging.js";
import { CATEGORY_LABELS, REASON_CATEGORIES } from "./reason-codes.js";

const sources = (n: number): TagSource[] =>
  Array.from({ length: n }, (_, i) => ({ runId: "stage1-x", key: `stage1-x|P${i % 5}|A|claude-haiku-4-5|${i}`, ...(i % 7 === 0 ? {} : { statedReason: `reason number ${i} about paying` }) }));

describe("drawTagSample", () => {
  it("draws the requested number of reasons, skipping calls with no stated reason", () => {
    const s = drawTagSample(sources(200), TAG_SAMPLE_SIZE, 1, "r");
    expect(s.items).toHaveLength(40);
    expect(new Set(s.items.map((i) => i.id)).size).toBe(40);
    expect(s.items.every((i) => i.text.startsWith("reason number"))).toBe(true);
    expect(Object.keys(s.key).sort()).toEqual(s.items.map((i) => i.id).sort());
  });

  it("is the same for the same seed, and differs for another", () => {
    const a = drawTagSample(sources(200), 40, 1, "r");
    expect(drawTagSample(sources(200), 40, 1, "r")).toEqual(a);
    expect(drawTagSample(sources(200), 40, 2, "r").items.map((i) => i.text)).not.toEqual(a.items.map((i) => i.text));
  });

  it("keeps the id opaque: it names no cell, arm, model or run, and the items carry nothing but id and text", () => {
    const s = drawTagSample(sources(100), 8, 3, "p");
    for (const i of s.items) {
      expect(Object.keys(i).sort()).toEqual(["id", "text"]);
      expect(i.id).toMatch(/^p-[bcdfghjkmnpqrstvwxz2-9]{4}$/);
    }
  });

  it("gives ids that carry no order: they do not count up through the draw", () => {
    const ids = drawTagSample(sources(200), 40, 1, "r").items.map((i) => i.id);
    expect([...ids].sort()).not.toEqual(ids);
    expect(new Set(ids).size).toBe(40);
  });

  it("refuses when there are too few reasons", () => {
    expect(() => drawTagSample(sources(20), 40, 1, "r")).toThrow(/only/);
  });
});

describe("the category descriptions", () => {
  // Words the keyword rules fire on (docs/marketplace_plan.md §14.6). A description that uses them invites ticking by matching words.
  const TRIGGERS = /preserv|reserv|keep|sav(e|es|ing)\b|set(s)? aside|earmark|plenty|enough|sufficient|ample|cheap|minimal|economic|efficien|liquid|flexib|rising|falling|trend|expir|lapse|deadline|hedg|diversif|simple|standard|safe|default|familiar|ordinary|brief|neutral|scoring rule|as stated|worthless/i;

  it("say what each category means and use none of the rules' trigger words", () => {
    for (const c of REASON_CATEGORIES) {
      expect(TAG_MEANINGS[c].length).toBeGreaterThan(20);
      expect(TAG_MEANINGS[c]).not.toMatch(TRIGGERS);
    }
  });

  it("say that ordering steps counts as 9 and that being able to pay is not 3 (practice round, D65)", () => {
    const html = renderTaggingPage({ mode: "real", items: [{ id: "r-aaaa", text: "x" }] });
    expect(html).toContain("the order of steps that gets things moving");
    expect(html).toContain("A remark that the agent can afford the payment is not number 3");
    expect(html).not.toContain("or why now");
    expect(TAG_MEANINGS.balance_size).toContain("does not count");
    expect(TAG_MEANINGS.no_asset_reason).toContain("the order in which to take steps");
  });

  it("are the ones the page shows, not the rules file's labels", () => {
    const html = renderTaggingPage({ mode: "real", items: [{ id: "r-aaaa", text: "x" }] });
    for (const c of REASON_CATEGORIES) {
      expect(html).toContain(TAG_MEANINGS[c]);
      expect(html).not.toContain(CATEGORY_LABELS[c].split(" — ")[1]);
    }
  });
});

describe("renderTaggingPage", () => {
  const items = drawTagSample(sources(100), PRACTICE_SAMPLE_SIZE, 1, "p").items;
  const html = renderTaggingPage({ mode: "practice", items });

  it("names the page, states it is practice, and carries the instructions and all nine categories", () => {
    expect(html).toContain(`<title>${TAGGING_TITLE}</title>`);
    expect(html).toContain("Practice round");
    expect(html).toContain("How this works");
    expect(html).toContain("Tick every category that fits");
    for (const c of REASON_CATEGORIES) expect(html).toContain(CATEGORY_LABELS[c].split(" — ")[0]);
    expect(html).toContain("None of these");
    expect(html).toContain("TYPE-1 to TYPE-4 are four kinds of job");
  });

  it("says Real round for the real one", () => {
    expect(renderTaggingPage({ mode: "real", items })).toContain(`Real round, ${items.length} reasons`);
  });

  it("is blind: nothing in the page names a model, an arm, a cell, a run or the rules' fingerprint", () => {
    const real = renderTaggingPage({ mode: "real", items });
    for (const banned of ["claude-haiku", "claude-sonnet", "stage1", "P0", "arm A", "fingerprint", "6d718eb1"]) expect(real).not.toContain(banned);
  });

  it("puts a reason's text in data, with < escaped so it cannot close the script or add markup", () => {
    const evil = renderTaggingPage({ mode: "real", items: [{ id: "r1", text: "x </script><img src=x onerror=alert(1)> y" }] });
    expect(evil).not.toContain("</script><img");
    expect(evil).toContain("\\u003c/script>");
  });

  it("saves to a db collection per mode and offers a download through the capability", () => {
    expect(html).toContain('var collectionName = "tags_" + mode;');
    expect(html).toContain('use("downloads")');
    expect(html).toContain("localStorage");
  });

  it("has a script that parses", () => {
    const m = /<script>([\s\S]*)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    expect(() => new Function(m![1])).not.toThrow();
  });
});
