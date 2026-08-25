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
    expect(html).toContain("publish daily");
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

  it("keeps a superseded point on the chart, rendered distinctly, rather than dropping it", () => {
    const html = renderSeriesPage({
      allPrints: [
        entry({ print_id: "2026-08-18", date: "2026-08-18", dated_siu: "0.0015" }),
        entry({
          print_id: "2026-08-22",
          date: "2026-08-22",
          dated_siu: "0.0007",
          superseded_by: {
            print_id: "2026-08-22b",
            reason: "Insufficient qualifying set: only 2 of 6 models qualified.",
          },
        }),
        entry({ print_id: "2026-08-22b", date: "2026-08-22", dated_siu: "0.0014" }),
      ],
      basePath: "",
    });
    expect(html).toContain("series-point-superseded");
    expect(html).toContain(">superseded<"); // the visible annotation, not just a hover title
    expect(html).toContain("superseded by 2026-08-22b");
  });

  it("picks the standing (non-superseded) print as latest, even when it shares a date with the superseded one", () => {
    const html = renderSeriesPage({
      allPrints: [
        entry({
          print_id: "2026-08-22",
          date: "2026-08-22",
          dated_siu: "0.0007",
          superseded_by: { print_id: "2026-08-22b", reason: "thin qualifying set" },
        }),
        entry({ print_id: "2026-08-22b", date: "2026-08-22", dated_siu: "0.0014" }),
      ],
      basePath: "",
    });
    expect(html).toContain("Dated SIU — 2026-08-22b");
    expect(html).toContain("$0.0014"); // the standing print's figure, not the superseded one's
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

  it("lists a day the scheduled run failed, linking to the failed run — not plotted as a value", () => {
    const html = renderSeriesPage({
      allPrints: [entry({})],
      incidents: [
        {
          date: "2026-08-25",
          run_url: "https://github.com/petrkrulis2022/dated-siu-inference/actions/runs/32793706266",
          reason: "only 3 of 5 registered models qualified (minimum 4)",
          occurred_at: "2026-08-25T00:33:35Z",
        },
      ],
      basePath: "",
    });
    expect(html).toContain(
      'href="https://github.com/petrkrulis2022/dated-siu-inference/actions/runs/32793706266"',
    );
    expect(html).toContain("no print published, run failed");
  });

  it("omits the incidents note entirely when there are none", () => {
    const html = renderSeriesPage({ allPrints: [entry({})], incidents: [], basePath: "" });
    expect(html).not.toContain("incidents");
  });
});
