/**
 * Known USDC contract addresses per chain, for validating a quote's `settlement` entries.
 *
 * Resolved from Circle's own documentation via Circle's MCP server during planning of P11
 * (2026-08-15), not from memory — CLAUDE.md's ban on invented values applies to addresses as
 * much as to prices. Source: https://developers.circle.com/stablecoins/usdc-contract-addresses.
 * Decimals confirmed from the same source family
 * (https://developers.circle.com/stablecoins/quickstart-transfer-10-usdc-on-solana):
 * "USDC uses 6 decimal places" on every EVM chain.
 *
 * `arc-testnet`'s address was added speculatively at that time, ahead of any real use; it was
 * independently re-verified (not just re-trusted) on 2026-09-05 against two Circle doc pages
 * (the address-list above and
 * https://developers.circle.com/stablecoins/quickstarts/transfer-usdc-evm's Arc Testnet row) and
 * confirmed live via `TouchstoneEscrow`'s real deployment on Arc Testnet
 * (data/deployments/arc-testnet.json) — a `balanceOf` call against it returned a real nonzero
 * balance before deploying, not just a documented address. Arc Testnet's native gas currency is
 * USDC itself (18 decimals at the protocol level); this map is the ERC-20 contract, which still
 * reports 6 decimals like every other chain's USDC.
 *
 * Build 1 only ever settles on Base (CLAUDE.md: "Deployment chain for contracts: Base"), but
 * Base Sepolia and Arc Testnet are included for the testnet flow build1-spec.md §10 calls for
 * ("Deploy scripts for Base Sepolia") and because Arc Testnet is now a real, deployed,
 * ETHOnline-2026 testbed target, not just a placeholder kept warm for later.
 */
export const USDC_ADDRESSES: Record<string, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "arc-testnet": "0x3600000000000000000000000000000000000000",
};

export function usdcAddressFor(chain: string): string | undefined {
  return USDC_ADDRESSES[chain];
}
