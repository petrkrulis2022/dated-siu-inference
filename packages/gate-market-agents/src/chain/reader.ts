import { createPublicClient, http, parseAbiItem, type Hex, type PublicClient } from "viem";
import {
  CAPACITY_BOND_ABI,
  CLAIM_ROUTER_ABI,
  ESCROW_READ_ABI,
  USDC_BALANCE_ABI,
  WORK_CLAIM_ABI,
} from "./abi.js";
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

  /**
   * Which issuer `ClaimRouter.route` would pick for a mint of `amount` in `classId` RIGHT NOW, or
   * null when no issuer has the headroom (the router reverts `NoIssuerWithHeadroom`).
   *
   * An `eth_call`, so nothing is minted and nothing is spent. Deliberately NOT on the `ChainReader`
   * interface: it is only needed by the runner's topology preconditions, and widening the
   * interface would force every test double to grow a method it never uses.
   *
   * The null is part of the answer rather than an error, because "nobody can serve this" is a
   * legitimate state the preconditions must be able to tell apart from "the call failed" —
   * collapsing the two would let a dead RPC read as an empty pool.
   */
  async routeFor(classId: Hex, amount: bigint): Promise<Hex | null> {
    try {
      return await this.client.readContract({
        address: this.deployment.claimRouter.address as Hex,
        abi: CLAIM_ROUTER_ABI,
        functionName: "route",
        args: [classId, amount],
      });
    } catch (err) {
      // viem wraps the revert; match on the error NAME so a different failure is not swallowed.
      const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
      if (text.includes("NoIssuerWithHeadroom")) return null;
      throw err;
    }
  }

  /** The chain's own head, for bounding a log scan. */
  async latestBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  /** Has this holder ever presented this claim? The latch that decides whether settling it
   *  draws on the bond or merely expires it (fsiu-design.md §4.3a). */
  async everPresented(tokenId: bigint, holder: Hex): Promise<boolean> {
    return this.client.readContract({
      address: this.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "everPresented",
      args: [tokenId, holder],
    });
  }

  /**
   * `Minted` events in one block range — the only way to discover which tokenIds exist, since
   * nothing enumerates them. Callers chunk the range themselves: public endpoints cap
   * `eth_getLogs` at 1,000 blocks and reject anything wider outright.
   */
  async mintedBetween(
    from: bigint,
    to: bigint,
  ): Promise<
    { tokenId: bigint; issuer: string; buyer: string; quantity: bigint; windowTo: bigint }[]
  > {
    const logs = await this.client.getLogs({
      address: this.deployment.workClaim.address as Hex,
      event: parseAbiItem(
        "event Minted(uint256 indexed tokenId, address indexed issuer, address indexed buyer, bytes32 classId, bytes32 series, uint256 quantity, uint64 windowFrom, uint64 windowTo)",
      ),
      fromBlock: from,
      toBlock: to,
    });
    return logs.flatMap((l) => {
      const a = l.args as {
        tokenId?: bigint;
        issuer?: string;
        buyer?: string;
        quantity?: bigint;
        windowTo?: bigint;
      };
      if (
        a.tokenId === undefined ||
        a.issuer === undefined ||
        a.buyer === undefined ||
        a.quantity === undefined ||
        a.windowTo === undefined
      ) {
        // A log this ABI cannot fully decode is dropped rather than half-reported: a claim
        // described by guessed fields would be worse than one not listed at all.
        return [];
      }
      return [
        {
          tokenId: a.tokenId,
          issuer: a.issuer,
          buyer: a.buyer,
          quantity: a.quantity,
          windowTo: a.windowTo,
        },
      ];
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
