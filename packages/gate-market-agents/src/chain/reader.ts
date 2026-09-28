import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { CAPACITY_BOND_ABI, ESCROW_READ_ABI, USDC_BALANCE_ABI, WORK_CLAIM_ABI } from "./abi.js";
import type { GateMarketDeployment } from "./deployment.js";

/**
 * The read surface `get_balances`/`check_headroom` need. Real chain reads are the source of
 * truth — no shadow ledger to drift, matching this project's "the print is computed from
 * executed runs only" discipline applied to on-chain state instead of off-chain runs. An
 * interface (not a concrete class used directly) so `budget`/`tools` tests inject a mock and
 * never touch a live chain, mirroring `packages/agents/src/seller.ts`'s `SellerDeps` pattern.
 */
export interface ClaimWindow {
  windowFrom: bigint;
  windowTo: bigint;
}

export interface ChainReader {
  usdcBalance(account: Hex): Promise<bigint>;
  claimBalance(tokenId: bigint, account: Hex): Promise<bigint>;
  headroom(issuer: Hex, classId: Hex): Promise<bigint>;
  issuanceLimit(issuer: Hex, classId: Hex): Promise<bigint>;
  /** A claim's real minted window — the source of truth for `time_to_expiry` (spec §7.1a). */
  claimWindow(tokenId: bigint): Promise<ClaimWindow>;
  /** The devnet/chain's own clock — not `Date.now()`. `default-and-reroute.ts`'s own
   * `advanceTime` already established why: an anvil devnet's clock can be warped independent of
   * real wall time, so anything computing "time until this window closes" must read the same
   * clock the contract itself checks. */
  currentBlockTimestamp(): Promise<bigint>;
  /** One escrow's real on-chain state, by the hash of the quote it was opened against. The
   * contract exposes a mapping rather than an enumeration, so the caller must already know which
   * quote to ask about — the quote board supplies that. */
  escrowState(escrowAddress: Hex, quoteHash: Hex): Promise<EscrowState>;
  /** One quote's capacity reservation, as `WorkClaim` records it. `exists` is false for a
   * quote nobody reserved against — an ordinary state, not an error, since the fSIU route never
   * reserves at all. */
  reservation(workClaimAddress: Hex, quoteHash: Hex): Promise<WorkReservation>;
  /** Every issuer bonded in a class, in registration order — the same order `ClaimRouter.route`
   * walks when it picks one. Lets a buyer see the whole shared pool rather than one issuer it
   * already knew the address of. */
  issuersForClass(classId: Hex): Promise<readonly Hex[]>;
}

export interface WorkReservation {
  exists: boolean;
  released: boolean;
  issuer: Hex;
  classId: Hex;
  quantityMilliSiu: bigint;
  deadlineUnix: bigint;
}

export type EscrowStatus = "none" | "open" | "settled" | "expired";

export interface EscrowState {
  status: EscrowStatus;
  buyer: Hex;
  seller: Hex;
  maxAmountMinorUnits: bigint;
  expiryUnix: bigint;
}

/** Index order matches `TouchstoneEscrow.Status` exactly (None, Open, Settled, Expired). */
const ESCROW_STATUS: readonly EscrowStatus[] = ["none", "open", "settled", "expired"];

export class ViemChainReader implements ChainReader {
  private readonly client: PublicClient;

  constructor(
    private readonly deployment: GateMarketDeployment,
    rpcUrl: string,
  ) {
    this.client = createPublicClient({ transport: http(rpcUrl) });
  }

  async usdcBalance(account: Hex): Promise<bigint> {
    return this.client.readContract({
      address: this.deployment.usdc.address as Hex,
      abi: USDC_BALANCE_ABI,
      functionName: "balanceOf",
      args: [account],
    });
  }

  async claimBalance(tokenId: bigint, account: Hex): Promise<bigint> {
    return this.client.readContract({
      address: this.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "balanceOf",
      args: [account, tokenId],
    });
  }

  async headroom(issuer: Hex, classId: Hex): Promise<bigint> {
    return this.client.readContract({
      address: this.deployment.capacityBond.address as Hex,
      abi: CAPACITY_BOND_ABI,
      functionName: "headroom",
      args: [issuer, classId],
    });
  }

  async issuanceLimit(issuer: Hex, classId: Hex): Promise<bigint> {
    return this.client.readContract({
      address: this.deployment.capacityBond.address as Hex,
      abi: CAPACITY_BOND_ABI,
      functionName: "issuanceLimit",
      args: [issuer, classId],
    });
  }

  async claimWindow(tokenId: bigint): Promise<ClaimWindow> {
    const [, , , windowFrom, windowTo] = await this.client.readContract({
      address: this.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "claimTypes",
      args: [tokenId],
    });
    return { windowFrom, windowTo };
  }

  async issuersForClass(classId: Hex): Promise<readonly Hex[]> {
    return this.client.readContract({
      address: this.deployment.capacityBond.address as Hex,
      abi: CAPACITY_BOND_ABI,
      functionName: "issuersForClass",
      args: [classId],
    });
  }

  async reservation(workClaimAddress: Hex, quoteHash: Hex): Promise<WorkReservation> {
    const [issuer, classId, quantity, deadline, released, exists] = await this.client.readContract({
      address: workClaimAddress,
      abi: WORK_CLAIM_ABI,
      functionName: "reservations",
      args: [quoteHash],
    });
    return {
      exists,
      released,
      issuer,
      classId,
      quantityMilliSiu: quantity,
      deadlineUnix: deadline,
    };
  }

  async escrowState(escrowAddress: Hex, quoteHash: Hex): Promise<EscrowState> {
    const [buyer, expiry, status, seller, , maxAmount] = await this.client.readContract({
      address: escrowAddress,
      abi: ESCROW_READ_ABI,
      functionName: "escrows",
      args: [quoteHash],
    });
    return {
      status: ESCROW_STATUS[status] ?? "none",
      buyer,
      seller,
      maxAmountMinorUnits: maxAmount,
      expiryUnix: expiry,
    };
  }

  async currentBlockTimestamp(): Promise<bigint> {
    const block = await this.client.getBlock();
    return block.timestamp;
  }
}
