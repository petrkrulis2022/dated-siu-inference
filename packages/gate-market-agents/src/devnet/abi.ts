import { parseAbi } from "viem";

/** Devnet-provisioning-only fragments — `createLot` and USDC mint/approve are things a real
 * agent tool never calls in production (an issuer's lot exists once, created out of band; USDC
 * is real and never permissionlessly minted on a real chain), so they stay out of
 * `chain/abi.ts`, which is the real tool surface. */
export const CAPACITY_BOND_PROVISIONING_ABI = parseAbi([
  "function createLot(bytes32 classId, uint256 committedCapacityHours, uint256 measuredRateMilliSiuPerHour, uint256 bondedUsdc) external",
]);

export const MOCK_USDC_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
]);
