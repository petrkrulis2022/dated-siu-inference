import { describe, expect, it } from "vitest";
import { PRACTICE_SAMPLE_SIZE, TAGGING_TITLE, TAG_SAMPLE_SIZE, drawTagSample, renderTaggingPage, type TagSource } from "./tagging.js";
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
      expect(i.id).toMatch(/^p\d$/);
    }
  });

  it("refuses when there are too few reasons", () => {
    expect(() => drawTagSample(sources(20), 40, 1, "r")).toThrow(/only/);
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
