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

  it("emits no client JS, matching the rest of the site", () => {
    const html = renderForAgentsPage();
    expect(html).not.toContain("<script");
  });
});
