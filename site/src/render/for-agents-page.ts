import type { ChainInfo } from "../data.js";
import { esc } from "../format.js";
import { EXCLUDED_FIELDS, RAW_PRINT_URL, VERIFY_JSON_URL, VERIFY_SCRIPT_URL, chainName } from "../verify-recipe.js";

const MCP_URL = "https://mcp.touchstoneassay.com/mcp";
const MCP_JSON_URL = "https://prints.touchstoneassay.com/mcp.json";
const LLMS_TXT_URL = "https://prints.touchstoneassay.com/.well-known/llms.txt";

const MCP_CONFIG_JSON = `{
  "mcpServers": {
    "touchstone-assay": {
      "url": "${MCP_URL}"
    }
  }
}`;

interface ToolRow {
  name: string;
  args: string;
  price: string;
}

const TOOLS: ToolRow[] = [
  { name: "get_index", args: "version?, date?", price: "free" },
  { name: "get_quote", args: "task_class, model", price: "$0.001" },
  { name: "convert", args: "model, input_tokens, output_tokens", price: "$0.001" },
  { name: "verify_receipt", args: "chain, tx_hash", price: "$0.01" },
];

interface TryItHereTool {
  name: string;
  label: string;
  description: string;
}

const TRY_IT_HERE_TOOLS: TryItHereTool[] = [
  {
    name: "get_current_print",
    label: "Get current print",
    description: "Returns the current Dated SIU value, date, and status from the live, signed print.",
  },
  {
    name: "explain_siu",
    label: "Explain SIU",
    description: "Explains what one SIU is: the basket, the quality gate, how the print is computed.",
  },
  {
    name: "compare_model_cost",
    label: "Compare model cost",
    description: "Returns the current print's exchange-rate table — every constituent model's real cost, in SIU.",
  },
];

/**
 * The human-readable counterpart to /mcp.json and /.well-known/llms.txt — the same facts, laid
 * out for someone deciding whether to point their agent at this server, not for a parser. Carries
 * exactly one client script (client/try-it-here.js, page-scoped — see layout.test.ts's sitewide
 * script-count invariant, which this page doesn't affect) powering the "Try it here" section
 * below; every other section here is still plain text meant to be copied, not a live widget.
 */
export function renderForAgentsPage(chains: ChainInfo[] = []): string {
  const rows = TOOLS.map(
    (t) =>
      `<tr><td><code>${esc(t.name)}</code></td><td><code>${esc(t.args)}</code></td><td>${esc(t.price)}</td></tr>`,
  ).join("\n");

  return `<div class="headline">
  <div class="label">For agents</div>
  <p class="note">Touchstone Assay's four MCP tools, live on Base Sepolia — a testbed, not
  traction. <code>get_index</code> is free; the other three settle in USDC over x402 via Circle
  Gateway.</p>
</div>

<section class="block">
  <h2>MCP config</h2>
  <p class="note">Streamable HTTP. Paste this into a client that supports remote MCP servers.</p>
  <div class="code-block">
    <pre>${esc(MCP_CONFIG_JSON)}</pre>
  </div>
  <p class="note">Machine-readable: <a href="mcp.json">${esc(MCP_JSON_URL)}</a> ·
  <a href=".well-known/llms.txt">${esc(LLMS_TXT_URL)}</a></p>
</section>

<section class="block">
  <h2>Tools</h2>
  <div class="table-scroll">
    <table>
      <thead><tr><th>Tool</th><th>Arguments</th><th>Price</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <p class="note">Prices settle in USDC on Base Sepolia (<code>eip155:84532</code>) via Circle
  Gateway nanopayments — an x402 402 challenge, paid, then the tool result. See
  <a href="https://github.com/petrkrulis2022/dated-siu-inference/blob/main/docs/datum-quote.md">docs/datum-quote.md</a>
  for the full settlement shape.</p>
</section>

<section class="block">
  <h2>What this is, plainly</h2>
  <p class="note">A measurement standard and data publication — never "backed by," never a peg,
  never an oracle, nothing for sale. <code>verify_receipt</code>'s on-chain read is live, reading
  the real deployed <code>TouchstoneEscrow</code> — see the <a href="index.html">Series</a> page
  for the current print and the full methodology.</p>
</section>

<section class="block" id="verify-a-print">
  <h2>Verify a print yourself</h2>
  <p class="note">Every print is signed and its fingerprint is recorded on chain. You can check one with no human in the loop.
  The whole procedure, with the contract addresses, is machine-readable at <a href="verify.json">${esc(VERIFY_JSON_URL)}</a>.</p>
  <ol class="verify-steps">
    <li>GET the print JSON: <code>${esc(RAW_PRINT_URL)}{print_id}.json</code> (the index of every print is <code>${esc(RAW_PRINT_URL)}index.json</code>).</li>
    <li>Remove exactly these fields and keep the rest as published: ${EXCLUDED_FIELDS.map((f) => `<code>${esc(f)}</code>`).join(", ")}.</li>
    <li>Canonicalise the rest with RFC 8785 (JCS), then take the keccak256 hash of its UTF-8 bytes (original Keccak padding, as Ethereum uses). That is the body hash.</li>
    <li>For each chain the print was anchored on — the print's <code>anchor</code> (Base Sepolia), then each entry of <code>anchor.additional_anchors</code> (Arc Testnet) — GET <code>{explorer}/api/v2/transactions/{tx_hash}/logs</code> and find the <code>PrintPosted</code> event from that chain's contract whose <code>bodyHash</code> equals yours. Its <code>timestamp</code> is when the hash was first recorded. An entry recorded as <code>failed</code> or <code>skipped</code> has no transaction to check; the print is valid without it.</li>
  </ol>
  <div class="code-block">
    <pre>curl -O ${esc(VERIFY_SCRIPT_URL)}
node verify-print.mjs 2026-10-14</pre>
    <div class="annotation">The script does all four steps, for every chain the print carries, with plain Node 18 or later: no install, no keys. Exit code 0 only if the hash was computed, at least one anchor carrying it was found, and no anchor the print claims was missing or different. It does not check the signature.</div>
  </div>
  ${
    chains.length === 0
      ? ""
      : `<div class="table-scroll">
    <table>
      <thead><tr><th>Chain</th><th>TouchstoneAttestation</th><th>Publisher</th><th>Anchoring</th></tr></thead>
      <tbody>${chains
        .map(
          (c) =>
            `<tr><td>${esc(chainName(c))}</td><td><a href="${esc(c.explorerBaseUrl)}/address/${esc(c.attestationAddress)}"><code>${esc(c.attestationAddress)}</code></a></td><td><code>${esc(c.publisherAddress)}</code></td><td>${c.anchoringLive === false ? "not yet live" : c.anchoringStartedOn !== undefined ? `live from the print dated ${esc(c.anchoringStartedOn)}` : "live"}</td></tr>`,
        )
        .join("\n      ")}</tbody>
    </table>
  </div>`
  }
  <p class="note">These contracts are on test networks. Anchoring proves that a print existed in this exact form by a given time; it does not prove the print's numbers are right.</p>
</section>

<section class="block" id="try-it-here">
  <h2>Agent try it here</h2>
  <p class="note" id="try-it-here-status">Checking this browser for WebMCP support…</p>
  <div class="tool-grid">
    ${TRY_IT_HERE_TOOLS.map(
      (tool) => `<div class="tool">
      <button type="button" class="tool-button" data-tool="${esc(tool.name)}"><code>${esc(tool.name)}</code></button>
      <p class="note">${esc(tool.description)}</p>
      <pre class="tool-result" data-tool-result="${esc(tool.name)}"></pre>
    </div>`,
    ).join("\n    ")}
  </div>
  <p class="note">Free, read-only, no exceptions — never <code>get_quote</code>,
  <code>convert</code>, or <code>verify_receipt</code>, which stay paid, on the remote server
  only. These three call the same live MCP server as the config above. If your browser or agent
  supports <a href="https://webmachinelearning.github.io/webmcp/">WebMCP</a> — an experimental
  W3C Community Group proposal, not yet a shipped standard — they're also registered directly
  with <code>document.modelContext</code>, in addition to the buttons.</p>
</section>
<script type="module" src="client/try-it-here.js"></script>`;
}
