import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  anchorIdempotently,
  type AnchorResult,
  type AttestationChain,
  type AttestationClient,
} from "./attestation.js";

/**
 * The real DatumAttestation client.
 *
 * `viem` is a new runtime dependency for this package, and the reason is that there previously
 * was no chain to talk to: P9 shipped a stub precisely because the contract did not exist. Now
 * that it is deployed, publication has to actually read `postedAt` and send `postPrint`. viem
 * was already resolved in the lockfile at 2.55.16 (transitive via the MCP server's Circle
 * dependency), so this pins a version already vetted in this repo rather than introducing a new
 * resolution.
 */
export const DATUM_ATTESTATION_ABI = [
  {
    type: "function",
    name: "postPrint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "bodyHash", type: "bytes32" },
      { name: "version", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "postedAt",
    stateMutability: "view",
    inputs: [{ name: "bodyHash", type: "bytes32" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "publisher",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export interface OnChainAttestationOptions {
  rpcUrl: string;
  /** Deployed DatumAttestation address — see data/deployments/<network>.json. */
  contractAddress: string;
  /** The publisher key. Must be the key the contract's immutable `publisher` was set to. */
  privateKeyHex: string;
  /** Recorded verbatim into the print's `anchor.chain`, e.g. "base-sepolia". */
  chainName: string;
}

export class OnChainAttestationClient implements AttestationClient {
  private readonly chain: AttestationChain;
  private readonly chainName: string;

  constructor(options: OnChainAttestationOptions) {
    const account = privateKeyToAccount(
      (options.privateKeyHex.startsWith("0x")
        ? options.privateKeyHex
        : `0x${options.privateKeyHex}`) as Hex,
    );
    const transport = http(options.rpcUrl);
    const publicClient = createPublicClient({ transport });
    const walletClient = createWalletClient({ account, transport });
    const address = options.contractAddress as Hex;

    this.chainName = options.chainName;
    this.chain = {
      async readPostedAt(bodyHash: string): Promise<bigint> {
        const result = await publicClient.readContract({
          address,
          abi: DATUM_ATTESTATION_ABI,
          functionName: "postedAt",
          args: [bodyHash as Hex],
        });
        return BigInt(result);
      },
      async sendPostPrint(bodyHash: string, version: string): Promise<string> {
        const chainId = await publicClient.getChainId();
        const txHash = await walletClient.writeContract({
          address,
          abi: DATUM_ATTESTATION_ABI,
          functionName: "postPrint",
          args: [bodyHash as Hex, version],
          account,
          chain: {
            id: chainId,
            name: options.chainName,
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: { default: { http: [options.rpcUrl] } },
          },
        });
        // Wait for inclusion so a returned hash always refers to a mined transaction, never one
        // still in the mempool that might yet be dropped.
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        // `waitForTransactionReceipt` resolves for reverted transactions too — a receipt means
        // "mined", not "succeeded". Without this check a revert (AlreadyPosted, NotPublisher,
        // out of gas) is indistinguishable from success, and the caller would record a
        // published anchor for a transaction that did nothing. Verified against Base Sepolia:
        // a duplicate postPrint mined with status 0 and was initially reported as anchored.
        if (receipt.status !== "success") {
          throw new Error(
            `postPrint transaction ${txHash} reverted on-chain (receipt status ` +
              `"${receipt.status}"). The caller re-reads postedAt to decide whether the hash ` +
              `is nonetheless anchored.`,
          );
        }
        return txHash;
      },
    };
  }

  /** Reads the on-chain anchoring time without sending anything. 0 means never anchored. */
  readPostedAt(bodyHash: string): Promise<bigint> {
    return this.chain.readPostedAt(bodyHash);
  }

  postPrint(bodyHash: string, version: string): Promise<AnchorResult> {
    return anchorIdempotently(this.chain, this.chainName, bodyHash, version);
  }
}
