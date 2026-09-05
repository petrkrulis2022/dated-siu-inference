import { describe, expect, it } from "vitest";
import { renderLayout } from "./layout.js";

describe("renderLayout", () => {
  it("includes the exact required disclaimer text in the footer", () => {
    const html = renderLayout({ title: "t", bodyHtml: "<p>x</p>", basePath: "" });
    expect(html).toContain(
      "SIU is a measurement standard and data publication. Nothing on this site is an offer of any token, security or investment.",
    );
  });

  it("escapes the title", () => {
    const html = renderLayout({ title: "<script>x</script>", bodyHtml: "", basePath: "" });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("applies basePath to every internal link", () => {
    const html = renderLayout({ title: "t", bodyHtml: "", basePath: "../" });
    expect(html).toContain('href="../styles.css"');
    expect(html).toContain('href="../index.html"');
    expect(html).toContain('href="../prints/index.html"');
    expect(html).toContain('href="../models/index.html"');
  });

  it("carries exactly the two expected <script> tags — the chat widget and the mode toggle — and nothing else", () => {
    // Was "contains no <script> tag" until the chat widget (Phase D), then "exactly one" until
    // the audience toggle needed its own sitewide script. Deliberately updated again, not
    // silently broken — this still guards the invariant that matters: no *third*, unreviewed
    // script sneaks in alongside these two.
    const html = renderLayout({ title: "t", bodyHtml: "<p>x</p>", basePath: "" });
    const scriptTags = html.match(/<script[^>]*>/gi) ?? [];
    expect(scriptTags).toEqual([
      '<script src="https://chat.touchstoneassay.com/widget.js" defer>',
      '<script type="module" src="client/mode-toggle.js" defer>',
    ]);
  });

  it("renders the audience toggle with the correct link active for each mode", () => {
    const human = renderLayout({ title: "t", bodyHtml: "", basePath: "" });
    expect(human).toMatch(/<a href="index\.html" aria-current="page">Human<\/a>/);
    expect(human).not.toMatch(/<a href="for-agents\.html" aria-current="page">/);

    const forAgents = renderLayout({ title: "t", bodyHtml: "", basePath: "", mode: "for-agents" });
    expect(forAgents).toMatch(/<a href="for-agents\.html" aria-current="page">For agents<\/a>/);
    expect(forAgents).not.toMatch(/<a href="index\.html" aria-current="page">/);
    expect(forAgents).toContain('href="for-agents.html#try-it-here"');
  });

  it("is mobile-friendly: sets a real viewport meta tag", () => {
    const html = renderLayout({ title: "t", bodyHtml: "", basePath: "" });
    expect(html).toContain('name="viewport"');
    expect(html).toContain("width=device-width");
  });
});
