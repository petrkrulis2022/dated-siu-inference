/**
 * Exercises the deployed Arc Testnet buyer/seller Workers end to end, over real HTTPS against
 * already-live infrastructure — no local server, no mocks. Complements cli/agent-loop.ts (which
 * exercises Base Sepolia directly, in-process): this one just POSTs to the deployed buyer
 * Worker's own /run endpoint and reports what it did, since the buyer Worker already contains
 * the full discover→quote→compare→fund→settle→verify sequence (packages/agents/src/workers/buyer.ts).
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

interface BuyerRunResult {
  ok: boolean;
  latencyMs: number;
  log?: string[];
  error?: string;
}

async function main(): Promise<void> {
  console.log("=".repeat(78));
  console.log("Touchstone Assay Arc Testnet worker loop — TESTBED. Real calls, no mocks.");
  console.log("=".repeat(78));

  const buyerUrl = requireEnv("ARC_BUYER_WORKER_URL");
  console.log(`invoking deployed buyer Worker: POST ${buyerUrl}/run`);

  const start = Date.now();
  const res = await fetch(`${buyerUrl}/run`, { method: "POST", headers: { "content-type": "application/json" } });
  const result = (await res.json()) as BuyerRunResult;
  const wallClockMs = Date.now() - start;

  for (const line of result.log ?? []) {
    console.log(`  ${line}`);
  }

  console.log("\n" + "=".repeat(78));
  if (result.ok) {
    console.log(`SUMMARY — real, unattended, live Arc Testnet: OK in ${result.latencyMs}ms (wall clock ${wallClockMs}ms).`);
  } else {
    console.error(`SUMMARY — the loop did NOT complete cleanly: ${result.error}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
