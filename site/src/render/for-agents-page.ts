import { esc } from "../format.js";

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

/**
 * The human-readable counterpart to /mcp.json and /.well-known/llms.txt — the same facts, laid
 * out for someone deciding whether to point their agent at this server, not for a parser. No
 * client JS: the config block is plain text meant to be copied, not a live widget (see
 * layout.test.ts's no-client-JS invariant).
 */
export function renderForAgentsPage(): string {
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
</section>`;
}
