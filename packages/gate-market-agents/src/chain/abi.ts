import { parseAbi } from "viem";

/**
 * Hand-written minimal fragments, not the full Foundry build artifact — same approach
 * `packages/agents/src/escrow-client.ts` already established for `TouchstoneEscrow`, for the
 * same reason: no reusable write-side ABI/wrapper exists anywhere in the repo, and the full ABI
 * lives only in `packages/contracts/out/`, outside the pnpm workspace.
 */
export const WORK_CLAIM_ABI = parseAbi([
  "function mint(bytes32 classId, bytes32 series, uint256 quantity, uint64 windowFrom, uint64 windowTo, (string printId, bytes32 series, uint64 printDate, uint256 nanoUsdPerSiu, uint64 validUntil) att, bytes signature) external returns (uint256 tokenId)",
  "function presentForRedemption(uint256 tokenId, bytes32 taskSpecHash) external",
  "function serveRedemption(uint256 tokenId, address holder, uint256 quantity, bool passed, bytes32 receiptRef) external",
  "function settleWindowClose(uint256 tokenId, address holder, (string printId, bytes32 series, uint64 printDate, uint256 nanoUsdPerSiu, uint64 validUntil) att, bytes signature) external",
  "function reserveForWork(bytes32 quoteHash, bytes32 classId, uint256 quantity) external returns (address issuer)",
  "function releaseReservation(bytes32 quoteHash) external",
  "function reservations(bytes32 quoteHash) external view returns (address issuer, bytes32 classId, uint256 quantity, uint64 deadline, bool released, bool exists)",
  "function tokenIdFor(address issuer, bytes32 classId, bytes32 series, uint64 windowFrom, uint64 windowTo) external pure returns (uint256)",
  "function balanceOf(address account, uint256 id) external view returns (uint256)",
  "function everPresented(uint256 tokenId, address holder) external view returns (bool)",
  "function settled(uint256 tokenId, address holder) external view returns (bool)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data) external",
  "function claimTypes(uint256 tokenId) external view returns (address issuer, bytes32 classId, bytes32 series, uint64 windowFrom, uint64 windowTo, bool exists, uint256 referenceNanoUsdPerSiu)",
  "function SERIES_FRONTIER() external view returns (bytes32)",
  "function SERIES_COMMODITY() external view returns (bytes32)",
  "event Minted(uint256 indexed tokenId, address indexed issuer, address indexed buyer, bytes32 classId, bytes32 series, uint256 quantity, uint64 windowFrom, uint64 windowTo)",
  "event WorkReserved(bytes32 indexed quoteHash, address indexed issuer, address indexed seller, bytes32 classId, uint256 quantity, uint64 deadline)",
  "event ReservationReleased(bytes32 indexed quoteHash, address indexed issuer, bytes32 classId, uint256 quantity, bool settled)",
]);

/**
 * The two terminal states `settleWindowClose` can end in, as events. Kept apart from
 * `WORK_CLAIM_ABI` (functions) because it exists only so a tool can read its own receipt: a
 * settlement that reports a transaction hash and nothing else cannot be counted as an enforcement
 * without re-reading the chain afterwards.
 */
export const WORK_CLAIM_SETTLEMENT_EVENTS_ABI = parseAbi([
  "event Defaulted(uint256 indexed tokenId, address indexed holder, uint256 quantity, uint256 amountUsdc)",
  "event Expired(uint256 indexed tokenId, address indexed holder, uint256 quantity)",
]);

export const CAPACITY_BOND_ABI = parseAbi([
  "function headroom(address issuer, bytes32 classId) external view returns (uint256)",
  "function issuanceLimit(address issuer, bytes32 classId) external view returns (uint256)",
  "function issuersForClass(bytes32 classId) external view returns (address[] memory)",
]);

/** `TouchstoneEscrow`'s public `escrows` mapping getter — read-only, so a seller can see an
 * escrow standing in its favour. Added 2026-09-27: without it `get_balances` showed a paid
 * seller an unchanged wallet and no escrow at all, and it correctly refused to deliver. */
export const ESCROW_READ_ABI = parseAbi([
  "function escrows(bytes32 quoteHash) external view returns (address buyer, uint64 expiry, uint8 status, address seller, address settler, uint256 maxAmount)",
  "function feeBps() external view returns (uint16)",
]);

/** A plain ERC-20 transfer. Used by the currency lab's operator to set opening balances and to give an
 * escrow fee back; no agent tool transfers USDC outright. */
export const USDC_TRANSFER_ABI = parseAbi([
  "function transfer(address to, uint256 amount) external returns (bool)",
]);

export const USDC_BALANCE_ABI = parseAbi([
  "function balanceOf(address account) external view returns (uint256)",
]);

/**
 * `ClaimRouter.route`, the decision the whole single-issuer instrument turns on: first-fit over
 * `CapacityBond.issuersForClass` in registration order, returning the first issuer whose headroom
 * covers the amount, and reverting `NoIssuerWithHeadroom` when none does. Read-only, so it can be
 * called with `eth_call` to learn WHERE a mint would route without minting anything.
 */
export const CLAIM_ROUTER_ABI = parseAbi([
  "function route(bytes32 classId, uint256 amount) external view returns (address issuer)",
  "error NoIssuerWithHeadroom(bytes32 classId, uint256 amount)",
]);
