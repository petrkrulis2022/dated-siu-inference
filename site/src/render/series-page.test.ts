import { describe, expect, it } from "vitest";
import type { PrintIndexEntry } from "../data.js";
import { renderSeriesPage } from "./series-page.js";

function entry(overrides: Partial<PrintIndexEntry>): PrintIndexEntry {
  return {
    print_id: "2026-08-18",
    date: "2026-08-18",
    status: "provisional",
    dated_siu: "0.0015",
    ...overrides,
  };
}

describe("renderSeriesPage", () => {
  it("states plainly that no print exists yet, rather than rendering an empty chart", () => {
    const html = renderSeriesPage({ allPrints: [], basePath: "" });
    expect(html).toContain("No print has been published yet");
    expect(html).not.toContain("<svg");
  });

  it("with one print, renders a single point and does not fake a trend line", () => {
    const html = renderSeriesPage({ allPrints: [entry({})], basePath: "" });
    expect(html).toContain("<svg");
    expect(html).toContain("The series begins here");
    expect(html).toContain("publish weekly");
    expect(html).not.toContain("<polyline");
  });

  it("with several prints, draws a line and marks provisional vs. final distinctly", () => {
    const html = renderSeriesPage({
      allPrints: [
        entry({ print_id: "2026-08-04", date: "2026-08-04", status: "final", dated_siu: "0.0020" }),
        entry({
          print_id: "2026-08-11",
          date: "2026-08-11",
          status: "provisional",
          dated_siu: "0.0017",
        }),
        entry({
          print_id: "2026-08-18",
          date: "2026-08-18",
          status: "provisional",
          dated_siu: "0.0015",
        }),
      ],
      basePath: "",
    });
    expect(html).toContain("<polyline");
    expect(html).toContain("series-point-final");
    expect(html).toContain("series-point-provisional");
    expect(html).toContain("A falling line is normal and expected");
    expect(html).not.toContain("The series begins here");
  });

  it("links to the prints list with the given basePath", () => {
    const html = renderSeriesPage({ allPrints: [entry({})], basePath: "../" });
    expect(html).toContain('href="../prints/index.html"');
  });

  it("escapes a hostile print_id rather than injecting it", () => {
    const html = renderSeriesPage({
      allPrints: [entry({ print_id: "<script>alert(1)</script>" })],
      basePath: "",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
