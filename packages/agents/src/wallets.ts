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
const SELLER_GAS_FUNDING_WEI = 2_000_000_000_000_000n; // 0.002 ETH

export interface FundedSeller {
  account: Account;
  privateKey: Hex;
}

export async function generateAndFundSeller(
  buyer: ChainClients,
  label: string,
): Promise<FundedSeller> {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const txHash = await buyer.walletClient.sendTransaction({
    account: buyer.account,
    chain: undefined,
    to: account.address,
    value: SELLER_GAS_FUNDING_WEI,
  });
  const receipt = await buyer.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`Funding transaction for ${label} (${account.address}) reverted on-chain.`);
  }

  return { account, privateKey };
}
