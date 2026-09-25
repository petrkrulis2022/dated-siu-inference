import { parseAbi } from "viem";

/**
 * Hand-written minimal fragments, not the full Foundry build artifact — same approach
 * `packages/agents/src/escrow-client.ts` already established for `TouchstoneEscrow`, for the
 * same reason: no reusable write-side ABI/wrapper exists anywhere in the repo, and the full ABI
 * lives only in `packages/contracts/out/`, outside the pnpm workspace.
 */
export const WORK_CLAIM_ABI = parseAbi([
  "function mint(bytes32 classId, uint256 quantity, uint64 windowFrom, uint64 windowTo, (string printId, uint256 nanoUsdPerSiu, uint64 validUntil) att, bytes signature) external returns (uint256 tokenId)",
  "function presentForRedemption(uint256 tokenId, bytes32 taskSpecHash) external",
  "function serveRedemption(uint256 tokenId, address holder, uint256 quantity, bool passed, bytes32 receiptRef) external",
  "function settleWindowClose(uint256 tokenId, address holder, (string printId, uint256 nanoUsdPerSiu, uint64 validUntil) att, bytes signature) external",
  "function tokenIdFor(address issuer, bytes32 classId, uint64 windowFrom, uint64 windowTo) external pure returns (uint256)",
  "function balanceOf(address account, uint256 id) external view returns (uint256)",
  "function everPresented(uint256 tokenId, address holder) external view returns (bool)",
  "function settled(uint256 tokenId, address holder) external view returns (bool)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data) external",
  "function claimTypes(uint256 tokenId) external view returns (address issuer, bytes32 classId, uint64 windowFrom, uint64 windowTo, bool exists, uint256 referenceNanoUsdPerSiu)",
  "event Minted(uint256 indexed tokenId, address indexed issuer, address indexed buyer, bytes32 classId, uint256 quantity, uint64 windowFrom, uint64 windowTo)",
]);

export const CAPACITY_BOND_ABI = parseAbi([
  "function headroom(address issuer, bytes32 classId) external view returns (uint256)",
  "function issuanceLimit(address issuer, bytes32 classId) external view returns (uint256)",
  "function issuersForClass(bytes32 classId) external view returns (address[] memory)",
]);

export const USDC_BALANCE_ABI = parseAbi([
  "function balanceOf(address account) external view returns (uint256)",
]);
