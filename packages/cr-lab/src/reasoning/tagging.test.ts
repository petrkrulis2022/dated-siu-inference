/** The blind draw, the tag reader, the agreement figures and the page: what a person sees, what stays hidden, and what is refused. All passages here are illustrative, written for the tests. */
import { describe, expect, it } from "vitest";
import { agreementReport } from "./agreement.js";
import { PAGE_CUT_CHARS, drawPassageSample, textForPage } from "./draw.js";
import { DataFigures } from "./figures.js";
import type { Passage } from "./passages.js";
import { PAYMENT_SCHEME, RESEARCH_SCHEME } from "./schemes.js";
import { renderTagPage } from "./tag-page.js";
import { readTagsFile } from "./tagging-store.js";

const passage = (i: number, over: Partial<Passage> = {}): Passage => ({
  key: `2026-10-18|CR-VS-${i}::model-${i % 2}#1:narration:0`,
  window: "2026-10-18",
  model: `model-${i % 2}`,
  instance: `CR-VS-${i}`,
  text: `Passage number ${i}: I will list the catalog and then read the series for venue ${i}.`,
  shown: [],
  ...over,
});
const many = (n: number): Passage[] => Array.from({ length: n }, (_, i) => passage(i));

describe("the blind draw", () => {
  it("is reproducible from its label, and different under another label", () => {
    const a = drawPassageSample(many(30), 8, "x", "t");
    const b = drawPassageSample(many(30), 8, "x", "t");
    const c = drawPassageSample(many(30), 8, "y", "t");
    expect(b.items).toEqual(a.items);
    expect(b.sampleSha256).toBe(a.sampleSha256);
    expect(c.items.map((i) => i.text)).not.toEqual(a.items.map((i) => i.text));
  });

  it("gives items nothing but a random id and the passage, and keeps the key apart", () => {
    const d = drawPassageSample(many(30), 8, "x", "t");
    for (const it of d.items) {
      expect(Object.keys(it).sort()).toEqual(["id", "text"]);
      expect(it.id).toMatch(/^t-[bcdfghjkmnpqrstvwxz23456789]{4}$/);
      expect(d.key[it.id]).toBeDefined();
    }
    expect(new Set(d.items.map((i) => i.id)).size).toBe(8);
    const shown = JSON.stringify(d.items);
    expect(shown).not.toMatch(/model-\d|CR-VS-\d+::|2026-10-18\|/);
  });

  it("does not order the draw by where the passages came from", () => {
    const d = drawPassageSample(many(30), 30, "x", "t");
    const order = d.items.map((i) => Number(/number (\d+)/.exec(i.text)?.[1]));
    expect(order).not.toEqual([...order].sort((p, q) => p - q));
  });

  it("refuses a draw larger than the passages there are", () => {
    expect(() => drawPassageSample(many(5), 8, "x", "t")).toThrow(/only 5 passages/);
  });
});

describe("what the person reads", () => {
  it("hides figures from the data and keeps the agent's own scale words", () => {
    const shown = new DataFigures(['{"v":"482.7"}']);
    const p = passage(1, {
      text: "The volume 12,345,678.9 USD, 482.7 for alpha, looks like thousands, not millions.",
    });
    expect(textForPage(p, shown)).toBe(
      "The volume [figure] USD, [figure] for alpha, looks like thousands, not millions.",
    );
  });

  it("cuts a long passage and says how much was cut", () => {
    const t = textForPage(passage(1, { text: "word ".repeat(1000) }));
    expect(t.length).toBeLessThan(PAGE_CUT_CHARS + 80);
    expect(t).toMatch(/\[cut for the page: \d+ more characters\]$/);
  });
});

describe("reading tags back", () => {
  const items = [
    { id: "t-aaaa", text: "x" },
    { id: "t-bbbb", text: "y" },
  ];
  const good = {
    scheme: "research",
    sample_sha256: "s",
    tags: [
      { id: "t-aaaa", categories: ["discovery"], flag: false },
      { id: "t-bbbb", categories: ["none"], flag: false },
    ],
  };

  it("accepts a complete file made on this sample", () => {
    const r = readTagsFile(good, RESEARCH_SCHEME, items, "s");
    expect(r.problems).toEqual([]);
    expect(r.tags).toEqual([
      { id: "t-aaaa", ids: ["discovery"], flag: false },
      { id: "t-bbbb", ids: ["none"], flag: false },
    ]);
  });

  it("refuses a file for another scheme or another sample", () => {
    expect(
      readTagsFile({ ...good, scheme: "payment" }, RESEARCH_SCHEME, items, "s").problems.join(),
    ).toMatch(/payment/);
    expect(readTagsFile(good, RESEARCH_SCHEME, items, "other").problems.join()).toMatch(
      /different sample/,
    );
  });

  it("refuses a missing, repeated, unknown or empty tag", () => {
    const missing = { ...good, tags: [good.tags[0]] };
    expect(readTagsFile(missing, RESEARCH_SCHEME, items, "s").problems.join()).toMatch(
      /t-bbbb was not tagged/,
    );
    const twice = { ...good, tags: [good.tags[0], good.tags[0], good.tags[1]] };
    expect(readTagsFile(twice, RESEARCH_SCHEME, items, "s").problems.join()).toMatch(
      /tagged twice/,
    );
    const unknown = {
      ...good,
      tags: [{ id: "t-zzzz", categories: ["discovery"], flag: false }, ...good.tags],
    };
    expect(readTagsFile(unknown, RESEARCH_SCHEME, items, "s").problems.join()).toMatch(
      /not in the sample/,
    );
    const bogus = {
      ...good,
      tags: [{ id: "t-aaaa", categories: ["earmarking"], flag: false }, good.tags[1]],
    };
    expect(readTagsFile(bogus, RESEARCH_SCHEME, items, "s").problems.join()).toMatch(
      /unknown category "earmarking"/,
    );
    const empty = { ...good, tags: [{ id: "t-aaaa", categories: [], flag: false }, good.tags[1]] };
    expect(readTagsFile(empty, RESEARCH_SCHEME, items, "s").problems.join()).toMatch(
      /no box ticked/,
    );
  });

  it("refuses a flag the scheme lacks, accepts one it has, and keeps a clash as recorded", () => {
    const flagged = {
      ...good,
      tags: [{ id: "t-aaaa", categories: ["discovery"], flag: true }, good.tags[1]],
    };
    expect(readTagsFile(flagged, RESEARCH_SCHEME, items, "s").problems.join()).toMatch(
      /flag this scheme does not have/,
    );
    const pay = {
      scheme: "payment",
      sample_sha256: "s",
      tags: [
        { id: "t-aaaa", categories: ["earmarking", "no_asset_reason"], flag: true },
        { id: "t-bbbb", categories: [], flag: true },
      ],
    };
    const r = readTagsFile(pay, PAYMENT_SCHEME, items, "s");
    expect(r.problems).toEqual([]);
    expect(r.tags[0]?.ids).toEqual(["earmarking", "no_asset_reason"]);
  });
});

describe("agreement of the rules with a person", () => {
  const t = (id: string, human: string[], rules: string[]) => ({
    id,
    human: { ids: human, flag: false },
    rules,
  });

  it("counts both, person only, rules only and neither for each category", () => {
    const r = agreementReport(RESEARCH_SCHEME, [
      t("1", ["discovery"], ["discovery"]),
      t("2", ["discovery"], ["none"]),
      t("3", ["none"], ["discovery"]),
      t("4", ["none"], ["none"]),
    ]);
    const d = r.categories.find((c) => c.id === "discovery");
    expect(d).toMatchObject({ both: 1, humanOnly: 1, rulesOnly: 1, neither: 1, agree: 0.5 });
    expect(d?.kappa).toBeCloseTo(0, 6);
    expect(r.exactMatch).toBe(2);
  });

  it("gives kappa 1 for perfect agreement, and null where chance agreement is total", () => {
    const perfect = agreementReport(RESEARCH_SCHEME, [
      t("1", ["discovery"], ["discovery"]),
      t("2", ["none"], ["none"]),
    ]);
    expect(perfect.categories.find((c) => c.id === "discovery")?.kappa).toBeCloseTo(1, 6);
    // nobody and nothing ever uses restraining_cost: agreement is total and kappa has no meaning
    expect(perfect.categories.find((c) => c.id === "restraining_cost")?.kappa).toBeNull();
  });

  it("lists tags that break the exclusivity rules, as recorded", () => {
    const r = agreementReport(PAYMENT_SCHEME, [
      t("a", ["earmarking", "no_asset_reason"], []),
      t("b", ["earmarking"], []),
    ]);
    expect(r.clashes).toEqual(["a"]);
  });
});

describe("the page", () => {
  const items = [
    { id: "t-aaaa", text: 'A passage with <script>alert(1)</script> and "quotes" & more.' },
  ];
  const page = renderTagPage({
    scheme: RESEARCH_SCHEME,
    mode: "real",
    items,
    sampleSha256: "a".repeat(64),
  });

  it("is one self-contained file: no link, no external script, image or frame", () => {
    expect(page).not.toMatch(/<link\b|<script[^>]*\bsrc=|<img\b|<iframe\b|https?:\/\//);
  });

  it("carries the passages as data only, escaped so they cannot close the script", () => {
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("\\u003cscript>alert(1)");
  });

  it("shows no model, task, window or rules output, only the scheme's own words", () => {
    expect(page).not.toMatch(/claude|gpt|haiku|sonnet|CR-VS|2026-10/i);
    expect(page).toContain("Choosing the window");
    expect(page).toContain("Recovering from tool errors");
    expect(page).toContain("Handling units and scale");
  });

  it("marks a practice round as not counted", () => {
    expect(
      renderTagPage({
        scheme: RESEARCH_SCHEME,
        mode: "practice",
        items,
        sampleSha256: "a",
      }).toLowerCase(),
    ).toContain("not counted");
  });
});
