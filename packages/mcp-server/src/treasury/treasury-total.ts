import { GATEWAY, formatUsdc, parseUsdc, type GatewayChain } from "./gateway-withdrawal.js";

/**
 * When the treasury moves to a hardware wallet. Until then it is a dedicated hot wallet in MetaMask;
 * the owner's decision of 2026-11-28 is to move once it holds more than $100 in total, counting its
 * wallet USDC and its Circle Gateway balance on Base and Arc mainnet (USDC counted at $1). The payment
 * export (src/cli/export-payments.ts) checks this on every run and alerts, so the switch happens
 * rather than being remembered someday.
 */
export const HARDWARE_WALLET_THRESHOLD_USDC = 100_000_000n; // $100, in USDC's 6-decimal units

export interface TreasuryPart {
  where: string;
  /** USDC, 6-decimal units */
  amount: bigint;
}

export interface TreasuryTotalDeps {
  treasury: string;
  fetchImpl?: typeof fetch;
  /** JSON-RPC against a chain (the treasury's wallet USDC is an ERC-20 balanceOf call). */
  rpc?: (chain: GatewayChain, method: string, params: unknown[]) => Promise<unknown>;
}

async function publicRpc(chain: GatewayChain, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(chain.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(`${chain.name} RPC ${method}: ${json.error.message ?? "error"}`);
  return json.result;
}

/** The treasury's USDC on Base and Arc mainnet: its Gateway balance (Circle) and its wallet (on chain). */
export async function readTreasuryTotal(deps: TreasuryTotalDeps): Promise<{ parts: TreasuryPart[]; total: bigint }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const rpc = deps.rpc ?? publicRpc;
  const chains = GATEWAY.mainnet.chains;
  const res = await doFetch(`${GATEWAY.mainnet.api}/v1/balances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "USDC", sources: chains.map((c) => ({ domain: c.domain, depositor: deps.treasury })) }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json()) as { balances?: { domain: number; depositor: string; balance: string }[] };
  if (!Array.isArray(json.balances)) throw new Error(`Circle's /v1/balances answered without balances: ${JSON.stringify(json).slice(0, 200)}`);
  const parts: TreasuryPart[] = chains.map((c) => {
    const b = json.balances!.find((x) => x.domain === c.domain && x.depositor.toLowerCase() === deps.treasury.toLowerCase());
    return { where: `Gateway balance on ${c.name}`, amount: b ? parseUsdc(b.balance) : 0n };
  });
  const balanceOf = `0x70a08231${deps.treasury.slice(2).toLowerCase().padStart(64, "0")}`;
  for (const c of chains) {
    const out = await rpc(c, "eth_call", [{ to: c.usdc, data: balanceOf }, "latest"]);
    if (typeof out !== "string" || !/^0x[0-9a-fA-F]*$/.test(out)) throw new Error(`${c.name}: USDC balanceOf answered ${String(out)}`);
    parts.push({ where: `wallet on ${c.name}`, amount: out === "0x" ? 0n : BigInt(out) });
  }
  return { parts, total: parts.reduce((s, p) => s + p.amount, 0n) };
}

/**
 * The alert to raise, or undefined: once the total is more than the threshold, once per UTC day while
 * it stays above, so it can't be missed and doesn't nag every hour.
 */
export function hardwareWalletAlert(input: {
  total: bigint;
  lastAlertDay: string | undefined;
  today: string;
  threshold?: bigint;
}): string | undefined {
  const threshold = input.threshold ?? HARDWARE_WALLET_THRESHOLD_USDC;
  if (input.total <= threshold || input.lastAlertDay === input.today) return undefined;
  return (
    `ALERT: the treasury holds ${formatUsdc(input.total)} USDC in total (wallet plus Gateway balance, Base and Arc ` +
    `mainnet), more than the ${formatUsdc(threshold)} USDC limit set on 2026-11-28. It is time to move the treasury ` +
    `to a hardware wallet.`
  );
}
