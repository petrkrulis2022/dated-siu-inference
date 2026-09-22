import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { CAPACITY_BOND_ABI, USDC_BALANCE_ABI, WORK_CLAIM_ABI } from "./abi.js";
import type { GateMarketDeployment } from "./deployment.js";

/**
 * The read surface `get_balances`/`check_headroom` need. Real chain reads are the source of
 * truth — no shadow ledger to drift, matching this project's "the print is computed from
 * executed runs only" discipline applied to on-chain state instead of off-chain runs. An
 * interface (not a concrete class used directly) so `budget`/`tools` tests inject a mock and
 * never touch a live chain, mirroring `packages/agents/src/seller.ts`'s `SellerDeps` pattern.
 */
export interface ChainReader {
  usdcBalance(account: Hex): Promise<bigint>;
  claimBalance(tokenId: bigint, account: Hex): Promise<bigint>;
  headroom(issuer: Hex, classId: Hex): Promise<bigint>;
  issuanceLimit(issuer: Hex, classId: Hex): Promise<bigint>;
}

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
}
