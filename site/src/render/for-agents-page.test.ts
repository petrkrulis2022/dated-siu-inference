import { describe, expect, it } from "vitest";
import { renderForAgentsPage } from "./for-agents-page.js";

describe("renderForAgentsPage", () => {
  it("states get_index is free, prominently", () => {
    const html = renderForAgentsPage();
    expect(html).toContain(">get_index<");
    expect(html).toContain(">free<");
  });

  it("lists all four tools with their real prices", () => {
    const html = renderForAgentsPage();
    expect(html).toContain(">get_quote<");
    expect(html).toContain(">convert<");
    expect(html).toContain(">verify_receipt<");
    expect(html).toMatch(/\$0\.001[\s\S]*\$0\.001/);
    expect(html).toContain("$0.01");
  });

  it("includes a copy-paste MCP config pointing at the real live endpoint", () => {
    const html = renderForAgentsPage();
    expect(html).toContain("https://mcp.touchstoneassay.com/mcp");
    expect(html).toContain("&quot;mcpServers&quot;");
  });

  it("links to the machine-readable mcp.json and llms.txt, relative to the page", () => {
    const html = renderForAgentsPage();
    expect(html).toContain('href="mcp.json"');
    expect(html).toContain('href=".well-known/llms.txt"');
  });

  it("carries exactly the one expected client script — the Try it here page-scoped one", () => {
    // Was "emits no client JS, matching the rest of the site" until the Try it here section
    // needed real, live buttons. Deliberately updated, not silently broken.
    const html = renderForAgentsPage();
    const scriptTags = html.match(/<script[^>]*>/gi) ?? [];
    expect(scriptTags).toEqual(['<script type="module" src="client/try-it-here.js">']);
  });

  it("renders the three Try it here tool buttons with result slots, and nothing paid", () => {
    const html = renderForAgentsPage();
    for (const tool of ["get_current_print", "explain_siu", "compare_model_cost"]) {
      expect(html).toContain(`data-tool="${tool}"`);
      expect(html).toContain(`data-tool-result="${tool}"`);
    }
    // The paid tools appear in the reference table above (as text, e.g. ">get_quote<"), but must
    // never appear as a Try-it-here button — this is a read-only, free demo, never a second free
    // front door to what agents are supposed to pay for.
    for (const paidTool of ["get_quote", "convert", "verify_receipt"]) {
      expect(html).not.toContain(`data-tool="${paidTool}"`);
    }
  });

  it("never mentions wSIU anywhere on this page", () => {
    const html = renderForAgentsPage();
    expect(html.toLowerCase()).not.toContain("wsiu");
  });
});
