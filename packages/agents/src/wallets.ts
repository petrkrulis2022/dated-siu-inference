import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/** `DEPLOYER_PRIVATE_KEY` (and every other raw hex secret in this repo's `.env`) is stored
 * without a `0x` prefix — same normalisation every ad hoc on-chain script this session needed. */
function normalizeKey(key: string): Hex {
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
}

export interface ChainClients {
  account: Account;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

export function clientsFor(privateKeyHex: string, rpcUrl: string): ChainClients {
  const account = privateKeyToAccount(normalizeKey(privateKeyHex));
  return {
    account,
    publicClient: createPublicClient({ transport: http(rpcUrl) }),
    walletClient: createWalletClient({ account, transport: http(rpcUrl) }),
  };
}

/**
 * Two fresh seller keypairs per demo run, funded with a small fixed ETH amount from the buyer
 * (`DEPLOYER_PRIVATE_KEY`, already funded from every prior on-chain test this session) — enough
 * gas for each seller's own `settle()` call. Gives genuinely distinct on-chain seller identities
 * without needing persistent seller secrets in `.env`. The buyer reuses `DEPLOYER_PRIVATE_KEY`
 * directly rather than generating a third fresh wallet — build1-spec.md §11 only asks for
 * distinct *sellers*, and the buyer's own identity has real transaction history from this
 * session's earlier live verification work.
 */
// 0.002 ETH was the original buffer here; at this session's observed real Base Sepolia gas
// prices (~0.01 gwei) a single settle() costs on the order of 0.000002 ETH, so 0.002 ETH was
// ~1000x more than a seller ever actually spends. Lowered after the deployer's cumulative real
// testnet ETH spend across this session's many live runs left too little to fund two sellers at
// the old amount — 0.0001 ETH still leaves ~45x margin over a real settle() at these prices.
const SELLER_GAS_FUNDING_WEI = 100_000_000_000_000n; // 0.0001 ETH

export interface FundedSeller {
  account: Account;
  privateKey: Hex;
}

/**
 * The same RPC-lag family documented on `retryUntilConclusive` (`@touchstone/sdk`), one more
 * shape of it: `sendTransaction` with no explicit nonce fetches the buyer's pending nonce fresh
 * from whichever node answers, and even *after* this function's own `waitForTransactionReceipt`
 * confirms a prior send mined, a second back-to-back send can still hit a node that hasn't
 * caught up — reusing the same nonce and reverting with "replacement transaction underpriced".
 * Confirmed live: two sequential `generateAndFundSeller` calls from `cli/demo.ts` hit exactly
 * this. Not routed through `retryUntilConclusive` itself — that helper retries a *read* until a
 * value is conclusive, whereas this retries the *send* itself — but it's the same lesson: a
 * write immediately following another write against this account cannot trust the first
 * lagging RPC node it happens to reach.
 */
function isNonceRaceError(err: unknown): boolean {
  return err instanceof Error && /replacement transaction underpriced|nonce/i.test(err.message);
}

export async function generateAndFundSeller(
  buyer: ChainClients,
  label: string,
): Promise<FundedSeller> {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const attempts = 4;
  let txHash: Hex | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      txHash = await buyer.walletClient.sendTransaction({
        account: buyer.account,
        chain: undefined,
        to: account.address,
        value: SELLER_GAS_FUNDING_WEI,
      });
      break;
    } catch (err) {
      if (i === attempts - 1 || !isNonceRaceError(err)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  const receipt = await buyer.publicClient.waitForTransactionReceipt({ hash: txHash! });
  if (receipt.status !== "success") {
    throw new Error(`Funding transaction for ${label} (${account.address}) reverted on-chain.`);
  }

  return { account, privateKey };
}
