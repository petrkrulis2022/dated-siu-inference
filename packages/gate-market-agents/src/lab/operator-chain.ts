/**
 * The real `LabChain`: the operator's own transactions, through the same client factory and the same
 * confirmed-write helper the agents' tools use (`clientsFor`, `writeAndConfirm`). Not a hand-rolled client:
 * two viem copies are in play here, and a diagnostic built from the wrong one hides exactly the defects the
 * loop's clients have (spec §4.6bi).
 *
 * Reads go through a fresh reader and are repeated until two agree, because a balance read straight after a
 * write can come from a node that has not seen the write. A figure that will not hold still is an error,
 * never a guess.
 */
import { createPublicClient, http, parseEventLogs, type Hex } from "viem";
import { clientsFor } from "@touchstone/agents";
import { USDC_TRANSFER_ABI, WORK_CLAIM_ABI } from "../chain/abi.js";
import type { GateMarketDeployment } from "../chain/deployment.js";
import { signRateAttestation, type RateAttestation } from "../chain/rate-attestation.js";
import { ViemChainReader } from "../chain/reader.js";
import { writeAndConfirm } from "../chain/write.js";
import { readUntilStable } from "../cli/topology.js";
import type { EndowmentMint, LabChain, Signer } from "./operator.js";

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

export interface ViemLabChainInput {
  deployment: GateMarketDeployment;
  rpcUrl: string;
  /** The operator: pays for the endowment, gives fees back, settles the expiry. */
  operator: Signer;
  /** The publisher's key, which signs the rate attestation every mint carries. */
  publisherKeyHex: Hex;
  /** The print every mint attests to. */
  print: { printId: string; series: Hex; printDate: bigint; nanoUsdPerSiu: bigint };
  /** Seconds a rate attestation stays valid. */
  attestationValiditySeconds?: bigint;
}

export function viemLabChain(input: ViemLabChainInput): LabChain {
  const { deployment, rpcUrl, operator } = input;
  const fresh = (): ViemChainReader => new ViemChainReader(deployment, rpcUrl);
  const operatorClients = (): ReturnType<typeof clientsFor> => clientsFor(operator.privateKeyHex, rpcUrl);
  const workClaim = deployment.workClaim.address as Hex;

  return {
    now: () => fresh().currentBlockTimestamp(),
    usdcBalance: (a) => readUntilStable(() => fresh().usdcBalance(a)),
    claimBalance: (tokenId, a) => readUntilStable(() => fresh().claimBalance(tokenId, a)),
    headroom: (issuer, classId) => readUntilStable(() => fresh().headroom(issuer, classId)),
    ethBalance: (a) => createPublicClient({ transport: http(rpcUrl) }).getBalance({ address: a }),

    async transferUsdc(from: Signer, to: Hex, minorUnits: bigint): Promise<string> {
      const receipt = await writeAndConfirm(clientsFor(from.privateKeyHex, rpcUrl), {
        address: deployment.usdc.address as Hex,
        abi: USDC_TRANSFER_ABI,
        functionName: "transfer",
        args: [to, minorUnits],
      });
      return receipt.transactionHash;
    },

    async mintEndowment(mint: EndowmentMint) {
      const now = await fresh().currentBlockTimestamp();
      const attestation: RateAttestation = {
        printId: input.print.printId,
        series: input.print.series,
        printDate: input.print.printDate,
        nanoUsdPerSiu: input.print.nanoUsdPerSiu,
        validUntil: now + (input.attestationValiditySeconds ?? 3600n),
      };
      const signature = await signRateAttestation(attestation, deployment.network.chainId, workClaim, input.publisherKeyHex);
      const receipt = await writeAndConfirm(operatorClients(), {
        address: workClaim,
        abi: WORK_CLAIM_ABI,
        functionName: "mint",
        args: [mint.classId, mint.series, mint.quantityMilliSiu, mint.windowFrom, mint.windowTo, attestation, signature],
      });
      // The router picks the issuer inside the mint, so the token and its issuer are read from the event the
      // contract emitted, never derived beforehand.
      const minted = parseEventLogs({ abi: WORK_CLAIM_ABI, eventName: "Minted", logs: receipt.logs })[0];
      if (minted === undefined) throw new Error(`the endowment mint (tx ${receipt.transactionHash}) emitted no Minted event`);
      return { tokenId: minted.args.tokenId, issuer: minted.args.issuer as Hex, txHash: receipt.transactionHash };
    },

    async transferClaim(to: Hex, tokenId: bigint, quantity: bigint): Promise<string> {
      const receipt = await writeAndConfirm(operatorClients(), {
        address: workClaim,
        abi: WORK_CLAIM_ABI,
        functionName: "safeTransferFrom",
        args: [operator.address, to, tokenId, quantity, "0x"],
      });
      return receipt.transactionHash;
    },

    async settleExpired(tokenId: bigint, holder: Hex): Promise<string> {
      const receipt = await writeAndConfirm(operatorClients(), {
        address: workClaim,
        abi: WORK_CLAIM_ABI,
        functionName: "settleWindowClose",
        // Never presented, so this is an expiry: headroom restored, nothing paid, no bond touched, and the
        // attestation argument is unused on that branch (WorkClaim.settleWindowClose).
        args: [tokenId, holder, { printId: "", series: ZERO_BYTES32, printDate: 0n, nanoUsdPerSiu: 0n, validUntil: 0n }, "0x"],
      });
      return receipt.transactionHash;
    },
  };
}
