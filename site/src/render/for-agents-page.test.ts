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

describe("renderForAgentsPage: verify a print yourself", () => {
  const CHAINS = [
    { slug: "base-sepolia", name: "Base Sepolia", chainId: 84532, attestationAddress: "0xF60701793eD168ffd6e818e1DCcb600393297190", publisherAddress: "0x284ff2F8605Ff8AFeDa6959B856Bb7E6d48f845a", explorerBaseUrl: "https://base-sepolia.blockscout.com", anchoringLive: true },
    { slug: "arc-testnet", name: "Arc Testnet", chainId: 5042002, attestationAddress: "0x12b886b043feABc3d90bBae3ae206d22b208160d", publisherAddress: "0x284ff2F8605Ff8AFeDa6959B856Bb7E6d48f845a", explorerBaseUrl: "https://testnet.arcscan.app", anchoringLive: false },
  ];

  it("gives an agent the whole procedure, the one-command script and the machine-readable spec", () => {
    const html = renderForAgentsPage(CHAINS);
    expect(html).toContain('id="verify-a-print"');
    expect(html).toContain("verify.json");
    expect(html).toContain("curl -O https://prints.touchstoneassay.com/verify-print.mjs");
    for (const field of ["signature", "public_key", "anchor", "superseded_by", "correction_notes"]) expect(html).toContain(`<code>${field}</code>`);
    expect(html).toContain("/api/v2/transactions/{tx_hash}/logs");
    expect(html).toContain("PrintPosted");
  });

  it("lists each chain's contract and whether anchoring there is live", () => {
    const html = renderForAgentsPage(CHAINS);
    expect(html).toContain(CHAINS[0].attestationAddress);
    expect(html).toContain(CHAINS[1].attestationAddress);
    expect(html).toContain("not yet live");
  });

  it("tells an agent where the further chain's anchor is, and that a failed or skipped entry is not an error", () => {
    const html = renderForAgentsPage(CHAINS);
    expect(html).toContain("anchor.additional_anchors");
    expect(html).toContain("<code>failed</code> or <code>skipped</code>");
  });

  it("says live from the print an Arc anchor first landed on, when the data says so", () => {
    const html = renderForAgentsPage([CHAINS[0], { ...CHAINS[1], anchoringLive: true, anchoringStartedOn: "2026-10-15" }]);
    expect(html).toContain("live from the print dated 2026-10-15");
    expect(html).not.toContain("not yet live");
  });

  it("still renders without any chain table when none is given", () => {
    const html = renderForAgentsPage();
    expect(html).toContain('id="verify-a-print"');
    expect(html).not.toContain("<th>Anchoring</th>");
  });

  it("adds no script of its own", () => {
    expect((renderForAgentsPage(CHAINS).match(/<script[^>]*>/gi) ?? []).length).toBe(1);
  });
});
