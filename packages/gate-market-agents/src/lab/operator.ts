/**
 * Everything the operator does to the lab's chain, as one surface. The operator is not a participant: it sets
 * the opening balances, mints and hands out the opening endowment, and
 * returns capacity to the pool once the window has closed. All of it is recorded as operator action in the
 * run's report, apart from every agent's record, so no behavioural statistic can include it.
 *
 * `LabChain` is the seam: the runner is written against it and the arithmetic below is pure, so the
 * orchestration is tested without a chain. `viemLabChain` (`operator-chain.ts`) is the real implementation.
 */
import type { Hex } from "viem";
import type { AgentId } from "../identity/resolve.js";

/** A signer the operator can act as: the operator itself, or a trader's wallet it holds the key of. */
export interface Signer {
  label: string;
  address: Hex;
  privateKeyHex: string;
}

export interface EndowmentMint {
  classId: Hex;
  series: Hex;
  quantityMilliSiu: bigint;
  windowFrom: bigint;
  windowTo: bigint;
}

export interface LabChain {
  /** The chain's own clock. */
  now(): Promise<bigint>;
  /** Balances read until two reads agree, from fresh clients — a balance read straight after a write can be stale. */
  usdcBalance(account: Hex): Promise<bigint>;
  claimBalance(tokenId: bigint, account: Hex): Promise<bigint>;
  headroom(issuer: Hex, classId: Hex): Promise<bigint>;
  ethBalance(account: Hex): Promise<bigint>;
  transferUsdc(from: Signer, to: Hex, minorUnits: bigint): Promise<string>;
  /** Mints as the operator and returns the token and the issuer the router chose, read from the Minted event. */
  mintEndowment(mint: EndowmentMint): Promise<{ tokenId: bigint; issuer: Hex; txHash: string }>;
  /** The operator hands `quantity` of `tokenId` to `to`. */
  transferClaim(to: Hex, tokenId: bigint, quantity: bigint): Promise<string>;
  /** Expires one holder's unpresented position once its window has closed; restores the issuer's headroom. */
  settleExpired(tokenId: bigint, holder: Hex): Promise<string>;
}

export type UsdcMove =
  | { kind: "top_up"; seat: AgentId; minorUnits: bigint }
  | { kind: "return"; seat: AgentId; minorUnits: bigint };

/**
 * What it takes to give every trader exactly `opening` USDC: top up those below it from the operator, take
 * back the excess of those above it. A trader exactly at the figure moves nothing.
 */
export function planUsdcReset(current: ReadonlyMap<AgentId, bigint>, opening: bigint): UsdcMove[] {
  const moves: UsdcMove[] = [];
  for (const [seat, held] of current) {
    if (held < opening) moves.push({ kind: "top_up", seat, minorUnits: opening - held });
    else if (held > opening) moves.push({ kind: "return", seat, minorUnits: held - opening });
  }
  return moves;
}

/** What the operator's wallet must hold before the run: the top-ups and the endowment's mint cost. Nothing is given back (D30). */
export function operatorUsdcNeed(moves: readonly UsdcMove[], mintCostMinor: bigint): bigint {
  const topUps = moves.filter((m) => m.kind === "top_up").reduce((s, m) => s + m.minorUnits, 0n);
  return topUps + mintCostMinor;
}
