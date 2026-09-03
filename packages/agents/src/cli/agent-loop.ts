import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import {
  initMcpSession,
  callFreeMcpTool,
  callPaidMcpTool,
  parseMcpToolText,
} from "../mcp-payment-client.js";

/**
 * The complete testbed loop, exercised end to end against live Base Sepolia — no mocks, no
 * `skipPaywall`, no local server. TESTBED — Base Sepolia, not mainnet, not traction; this run
 * demonstrates the protocol working, not demand.
 *
 * 1. Discovers the server from its own published /mcp.json — no hardcoded second copy of the
 *    endpoint URL.
 * 2. [TODO once the chat widget (Phase D) ships] open a chat conversation, ask a real question,
 *    confirm it hands back the MCP config or a quote. Stubbed here — Phase C ships before
 *    Phase D, and this step should be filled in once /chat exists rather than block on it.
 * 3. Calls get_quote for real — a real 402, a real signed Gateway payment, a real settlement.
 * 4. Calls verify_receipt for real, against a real, independently-verifiable TouchstoneEscrow
 *    settlement (reused rather than fabricated: the demo agents' funding wallet is presently too
 *    low on Base Sepolia ETH to open a fresh escrow — see docs/README's DEPLOYER_PRIVATE_KEY note
 *    — so this reuses the same real 2026-08-18 settlement already verified live during MCP
 *    distribution work, not a mock).
 * 5. Reports every step's latency and real tx/transfer id — this run's own log *is* the "does the
 *    full loop work unattended" answer, not a claim about it.
 */

interface McpJsonManifest {
  remote: { url: string };
}

interface StepResult {
  step: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
}

const results: StepResult[] = [];

async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const value = await fn();
    results.push({ step, ok: true, latencyMs: Date.now() - start, detail: "" });
    return value;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ step, ok: false, latencyMs: Date.now() - start, detail });
    throw err;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value.startsWith("0x") ? value : `0x${value}`;
}

async function main(): Promise<void> {
  console.log("=".repeat(78));
  console.log("Touchstone Assay agent loop — TESTBED, Base Sepolia. Real calls, no mocks.");
  console.log("=".repeat(78));

  const buyerKey = requireEnv("MCP_BUYER_PRIVATE_KEY") as `0x${string}`;
  const gateway = new GatewayClient({ chain: "baseSepolia", privateKey: buyerKey });
  const balances = await gateway.getBalances();
  console.log(`buyer: ${gateway.address} (Gateway balance: ${balances.gateway.formattedAvailable} USDC)`);

  // --- 1. Discover the server from its own published manifest ---
  const manifest = await timed("discover (/mcp.json)", async () => {
    // prints.touchstoneassay.com, not the bare apex — that's a separate Cloudflare Pages
    // project (the marketing site, not in this repo). See the commit that fixed this same
    // mistake in site/static/mcp.json's own internal references.
    const res = await fetch("https://prints.touchstoneassay.com/mcp.json");
    if (!res.ok) throw new Error(`mcp.json fetch failed: ${res.status}`);
    return (await res.json()) as McpJsonManifest;
  });
  const mcpUrl = manifest.remote.url;
  console.log(`discovered MCP endpoint: ${mcpUrl}`);

  // --- get_index, free, for orientation (not counted as one of the numbered steps, but real) ---
  await timed("get_index (free)", async () => {
    const sessionId = await initMcpSession(mcpUrl, "touchstone-agent-loop");
    const result = await callFreeMcpTool(mcpUrl, sessionId, "get_index", {});
    const { isError, text } = parseMcpToolText(result.text);
    if (isError) throw new Error(text);
    const print = JSON.parse(text);
    console.log(`  current print: ${print.print_id} — Dated SIU $${print.dated_siu}`);
    return print;
  });

  // --- 2. Chat — TODO once /chat (Phase D) exists ---
  console.log("\n[2/5] chat: SKIPPED — Phase D (chat widget) has not shipped yet. TODO: open a");
  console.log("      session against the chat endpoint, ask a real question, confirm it hands");
  console.log("      back either the MCP config or a get_quote-shaped answer, before paying.");

  // --- 3. get_quote, real paid call ---
  const quoteResult = await timed("get_quote ($0.001, paid)", async () => {
    const sessionId = await initMcpSession(mcpUrl, "touchstone-agent-loop");
    const result = await callPaidMcpTool(gateway, mcpUrl, sessionId, "get_quote", {
      task_class: "T1",
      model: "deepseek-v3.2",
    });
    const { isError, text } = parseMcpToolText(result.text);
    if (isError) throw new Error(text);
    if (!result.transaction) throw new Error("get_quote succeeded but no settlement transaction was recorded.");
    console.log(`  settlement: ${result.transaction} (${result.amountUsdcMinorUnits} minor units USDC)`);
    return { ...JSON.parse(text), transaction: result.transaction };
  });
  console.log(`  quote: ${quoteResult.siu_per_call} SIU = $${quoteResult.usd_per_call} USDC`);

  // --- 4. verify_receipt, real paid call, against a real, independently-verifiable settlement ---
  const quotePath = resolve(
    import.meta.dirname,
    "../../../../data/.cache/quotes/0xd7b4cf92014ee8a5900b198a43ccecf57792d9eca96740664c89191bb51cce7e.json",
  );
  const reusedQuote = JSON.parse(readFileSync(quotePath, "utf-8"));
  const verifyResult = await timed("verify_receipt ($0.01, paid)", async () => {
    const sessionId = await initMcpSession(mcpUrl, "touchstone-agent-loop");
    const result = await callPaidMcpTool(gateway, mcpUrl, sessionId, "verify_receipt", {
      chain: "base-sepolia",
      tx_hash: "0xdc9c4b6a1ea25d5661cb7a2f7d8b628bc92f6f1b0602ca5d1e7f1bd56a38779b",
      quote: reusedQuote,
    });
    const { isError, text } = parseMcpToolText(result.text);
    if (isError) throw new Error(text);
    if (!result.transaction) throw new Error("verify_receipt succeeded but no settlement transaction was recorded.");
    console.log(`  settlement: ${result.transaction} (${result.amountUsdcMinorUnits} minor units USDC)`);
    return { ...JSON.parse(text), transaction: result.transaction };
  });
  console.log(`  receipt: matched=${verifyResult.matched} quoted=$${verifyResult.amount_quoted_usd} paid=$${verifyResult.amount_paid_usd}`);

  // --- 5. Report ---
  console.log("\n" + "=".repeat(78));
  console.log("SUMMARY — real, unattended, live Base Sepolia:");
  for (const r of results) {
    const status = r.ok ? "OK  " : "FAIL";
    console.log(`  [${status}] ${r.step.padEnd(28)} ${String(r.latencyMs).padStart(5)}ms  ${r.detail}`);
  }
  const anyFailed = results.some((r) => !r.ok);
  if (anyFailed) {
    console.error("\nThe loop did NOT complete cleanly — see FAIL rows above.");
    process.exitCode = 1;
  } else {
    console.log("\nThe full loop completed unattended, with real settlements on live Base Sepolia.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
