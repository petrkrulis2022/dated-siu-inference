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

/**
 * Reads the immutable `publisher` address directly — no private key needed. Used by the
 * independent-verification loop (packages/print/src/cli/verify-onchain.ts): compare this
 * against the address recovered from a print's own signature, never against the print's own
 * claimed `public_key` field.
 */
export async function readAttestationPublisher(
  rpcUrl: string,
  contractAddress: string,
): Promise<string> {
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  return publicClient.readContract({
    address: contractAddress as Hex,
    abi: DATUM_ATTESTATION_ABI,
    functionName: "publisher",
  });
}

/** Reads `postedAt` directly, no private key needed — the other half of independent
 * verification: is this exact body hash actually anchored, regardless of who anchored it? */
export async function readAttestationPostedAt(
  rpcUrl: string,
  contractAddress: string,
  bodyHash: string,
): Promise<bigint> {
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const result = await publicClient.readContract({
    address: contractAddress as Hex,
    abi: DATUM_ATTESTATION_ABI,
    functionName: "postedAt",
    args: [bodyHash as Hex],
  });
  return BigInt(result);
}

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
