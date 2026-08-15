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
  });

  it("contains no <script> tag — no backend, no analytics, no tracking", () => {
    const html = renderLayout({ title: "t", bodyHtml: "<p>x</p>", basePath: "" });
    expect(html.toLowerCase()).not.toContain("<script");
  });

  it("is mobile-friendly: sets a real viewport meta tag", () => {
    const html = renderLayout({ title: "t", bodyHtml: "", basePath: "" });
    expect(html).toContain('name="viewport"');
    expect(html).toContain("width=device-width");
  });
});
