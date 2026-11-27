import { createWalletClient, http, parseUnits, publicActions, defineChain, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import type { NextFunction, Request, Response } from "express";
import type { ToolMiddleware } from "./paywall.js";

/**
 * x402 "exact" payments this server verifies and settles ITSELF — for networks Circle's Gateway
 * does not cover (mainnet-switch brief §2A/§7: Kite). x402 is chain-agnostic; a third-party
 * facilitator is a convenience, not a requirement of the protocol, so for these networks the
 * server plays the facilitator role directly: it checks the buyer's EIP-3009
 * `transferWithAuthorization` signature against terms the SERVER built (never the client's), then
 * submits it on-chain from a gas-paying settler key. The funds move buyer → payTo in that one
 * transaction — the settler key pays gas and never holds, receives or can redirect revenue, and the
 * server never holds the receiving key (brief §3).
 *
 * Verification and settlement are @x402/evm's own reference `ExactEvmScheme` facilitator (the same
 * code any x402 facilitator runs), not a reimplementation: this module only supplies the network
 * config, the server-built requirements and the HTTP wiring. Circle's Gateway networks (Base, Arc)
 * are untouched — `withSelfSettledNetworks` passes every non-self-settled request straight through
 * to Circle's middleware, and only APPENDS this module's options to the 402 Circle builds, so one
 * 402 offers every network.
 */

/** One self-settled EVM network: chain, the stablecoin it accepts, and that token's EIP-712 domain. */
export interface SelfSettledNetwork {
  /** CAIP-2, e.g. "eip155:2368". */
  network: `eip155:${number}`;
  chainId: number;
  name: string;
  rpcUrl: string;
  /** The EIP-3009 stablecoin this network is paid in. */
  asset: `0x${string}`;
  decimals: number;
  /** The token's EIP-712 domain — what a buyer signs against. NOT always the token's `name()`. */
  eip712: { name: string; version: string };
  /**
   * The least this network asks for any call, in dollars ("0.005"). A payment here is its own
   * on-chain transaction, paid for in gas by this server, so a price below the gas it costs would
   * lose money on every call; a tool priced above this floor keeps its own price. Circle's batched
   * networks have no such floor — Gateway settles many payments in one transaction.
   */
  minimumPriceUsd: string;
}

/**
 * The Kite floor, decided 2026-10-25 from measurement (the owner delegated the pricing). A payment
 * took about 71,000 gas on Kite Testnet (59,466 for one anchoring post, for scale). On Kite mainnet
 * the base fee is a flat 25 gwei over the last 100 blocks (blocks 0.3% full) and the 150 gwei
 * priority fee a default wallet adds takes the price to 175 gwei: about 0.0125 KITE a payment at that
 * worst case. KITE has traded roughly $0.09 to $0.15 (sources disagree), so a payment costs about
 * $0.0011 to $0.0019 in gas. $0.005 covers the dearest case about 2.7 times over, and Kite's own
 * gasless relayer refuses transfers under $0.01, which says what Kite itself considers viable. A
 * lower priority fee would cut the gas several-fold; that is to be tested on mainnet before anyone
 * relies on it. Revisit with the settlement log once real payments exist.
 */
const KITE_MINIMUM_PRICE_USD = "0.005";

/**
 * Kite AI Testnet. Token, decimals and EIP-712 domain from Kite's own gasless integration guide
 * (https://docs.gokite.ai/kite-chain/9-gasless-integration) and its live supported-tokens list
 * (https://gasless.gokite.ai/supported_tokens), cross-checked on-chain 2026-10-24: chain id 2368,
 * `DOMAIN_SEPARATOR()` recomputes from ("PYUSD", "1", 2368, asset), and the contract carries
 * `transferWithAuthorization(…,v,r,s)` and `authorizationState`. 18 decimals — unlike mainnet.
 */
export const KITE_TESTNET: SelfSettledNetwork = {
  network: "eip155:2368",
  chainId: 2368,
  name: "KiteAI Testnet",
  rpcUrl: "https://rpc-testnet.gokite.ai/",
  asset: "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9",
  decimals: 18,
  eip712: { name: "PYUSD", version: "1" },
  minimumPriceUsd: KITE_MINIMUM_PRICE_USD,
};

/**
 * Kite AI Mainnet. USDC.e ("Bridged USDC (Kite AI)", bridged via Lucid — not Circle-native, which is
 * why Circle's Gateway can never cover Kite) from Kite's mainnet contract list
 * (https://docs.gokite.ai/kite-chain/3-developing/smart-contracts-list) and gasless guide, cross-checked
 * on-chain 2026-10-24: chain id 2366, a FiatToken-v2.2-class implementation with the canonical EIP-3009
 * typehash, and a `DOMAIN_SEPARATOR()` that recomputes from ("Bridged USDC (Kite AI)", "2") — neither
 * "USDC" nor "USD Coin", which most x402 tooling assumes.
 */
export const KITE_MAINNET: SelfSettledNetwork = {
  network: "eip155:2366",
  chainId: 2366,
  name: "KiteAI Mainnet",
  rpcUrl: "https://rpc.gokite.ai/",
  asset: "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",
  decimals: 6,
  eip712: { name: "Bridged USDC (Kite AI)", version: "2" },
  minimumPriceUsd: KITE_MINIMUM_PRICE_USD,
};

/** How long a buyer's signed authorization may sit before it expires — the standard x402 window. */
const MAX_TIMEOUT_SECONDS = 300;

/** The x402 v2 requirements this server demands for `price` on `net` — the only terms it settles. */
export interface ExactRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

/** A dollar string ("$0.001", "0.005") in this network's atomic token units — viem's string-based `parseUnits`, no floats. */
function atomicUnits(net: SelfSettledNetwork, dollars: string): bigint {
  const decimal = dollars.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(decimal)) throw new Error(`Unparseable price "${dollars}"`);
  return parseUnits(decimal, net.decimals);
}

/**
 * `price` is a TOOL_PRICES string ("$0.001"); the amount demanded is the larger of that and the
 * network's own floor (`minimumPriceUsd`), as atomic token units — no floating point anywhere in
 * the amount (CLAUDE.md invariant 4).
 */
export function exactRequirementsFor(
  net: SelfSettledNetwork,
  price: string,
  payTo: string,
): ExactRequirements {
  const asked = atomicUnits(net, price);
  const floor = atomicUnits(net, net.minimumPriceUsd);
  return {
    scheme: "exact",
    network: net.network,
    asset: getAddress(net.asset),
    amount: (asked > floor ? asked : floor).toString(),
    payTo: getAddress(payTo),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { name: net.eip712.name, version: net.eip712.version },
  };
}

type Facilitator = InstanceType<typeof ExactEvmScheme>;
export type PaymentPayload = Parameters<Facilitator["verify"]>[0];
type Requirements = Parameters<Facilitator["verify"]>[1];

export type SettleOutcome =
  { ok: true; payer: string; transaction: string; network: string } | { ok: false; reason: string };

/** Verifies and settles one payment on one self-settled network. */
export interface SelfSettler {
  verifyAndSettle(payload: PaymentPayload, requirements: ExactRequirements): Promise<SettleOutcome>;
}

/**
 * The real settler: @x402/evm's reference facilitator over a viem wallet on `net`, paying gas from
 * `settlerPrivateKey`. That key is a Worker secret the owner generates and funds with a small gas
 * balance (brief §3/§8 "relayer funded by Markets") — never generated, stored or logged here.
 */
export function createSelfSettler(net: SelfSettledNetwork, settlerPrivateKey: string): SelfSettler {
  const key = (
    settlerPrivateKey.startsWith("0x") ? settlerPrivateKey : `0x${settlerPrivateKey}`
  ) as `0x${string}`;
  const account = privateKeyToAccount(key);
  const chain = defineChain({
    id: net.chainId,
    name: net.name,
    nativeCurrency: { name: "KITE", symbol: "KITE", decimals: 18 },
    rpcUrls: { default: { http: [net.rpcUrl] } },
  });
  const client = createWalletClient({ account, chain, transport: http(net.rpcUrl) }).extend(
    publicActions,
  );
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args) => client.readContract(args as never),
    verifyTypedData: (args) => client.verifyTypedData(args as never),
    writeContract: (args) => client.writeContract(args as never),
    sendTransaction: (args) => client.sendTransaction(args as never),
    waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args as never),
    getCode: (args) => client.getCode(args as never),
  });
  const facilitator = new ExactEvmScheme(signer);

  return {
    async verifyAndSettle(payload, requirements) {
      const reqs = requirements as unknown as Requirements;
      const verified = await facilitator.verify(payload, reqs);
      if (!verified.isValid) {
        return {
          ok: false,
          reason: verified.invalidReason ?? verified.invalidMessage ?? "invalid payment",
        };
      }
      const settled = await facilitator.settle(payload, reqs);
      if (!settled.success) {
        return {
          ok: false,
          reason: settled.errorReason ?? settled.errorMessage ?? "settlement failed",
        };
      }
      return {
        ok: true,
        payer: settled.payer ?? verified.payer ?? "",
        transaction: settled.transaction,
        network: settled.network,
      };
    },
  };
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = (header: string): unknown =>
  JSON.parse(Buffer.from(header, "base64").toString("utf-8"));

/** The client-chosen terms must be exactly the server's — a buyer cannot sign its own price or payee. */
function sameTerms(accepted: unknown, ours: ExactRequirements): boolean {
  if (typeof accepted !== "object" || accepted === null) return false;
  const a = accepted as Record<string, unknown>;
  const lower = (v: unknown) => String(v ?? "").toLowerCase();
  return (
    a.scheme === ours.scheme &&
    a.network === ours.network &&
    lower(a.asset) === lower(ours.asset) &&
    String(a.amount) === ours.amount &&
    lower(a.payTo) === lower(ours.payTo)
  );
}

export interface SelfSettledOptions {
  networks: SelfSettledNetwork[];
  payTo: string;
  /** One settler per network, keyed by CAIP-2. */
  settlers: Record<string, SelfSettler>;
}

/**
 * Wraps one paid tool's Circle middleware (`inner`) so the same 402 also offers every self-settled
 * network, and a payment made on one of them is verified and settled here instead of at Circle.
 * Works unchanged on both deployments: it touches only `req.headers`, `res.setHeader`,
 * `res.statusCode` and `res.end` — the plain http surface Express and ./workers/node-shim.ts share.
 */
export function withSelfSettledNetworks(
  price: string,
  inner: ToolMiddleware,
  opts: SelfSettledOptions,
): ToolMiddleware {
  const ours = opts.networks.map((net) => exactRequirementsFor(net, price, opts.payTo));

  const reject = (res: Response, reason: string, offer: ExactRequirements[]) => {
    res.statusCode = 402;
    res.setHeader("PAYMENT-REQUIRED", encode({ x402Version: 2, error: reason, accepts: offer }));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: reason }));
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers["payment-signature"];

    if (typeof header !== "string" || header === "") {
      // Unpaid: let Circle build its 402, then append our options to the very header it sets.
      const setHeader = res.setHeader.bind(res);
      res.setHeader = ((name: string, value: string | number | readonly string[]) => {
        if (name.toLowerCase() === "payment-required") {
          const required = decode(String(value)) as { accepts?: unknown[] };
          value = encode({ ...required, accepts: [...(required.accepts ?? []), ...ours] });
        }
        return setHeader(name, value);
      }) as typeof res.setHeader;
      return inner(req, res, next);
    }

    let payload: PaymentPayload;
    try {
      payload = decode(header) as PaymentPayload;
    } catch {
      return inner(req, res, next); // not ours to judge — Circle's middleware rejects malformed headers itself
    }
    const accepted = (payload as { accepted?: { network?: string } }).accepted;
    const net = opts.networks.find((n) => n.network === accepted?.network);
    if (!net) return inner(req, res, next); // a Circle network: untouched

    const requirements = ours[opts.networks.indexOf(net)] as ExactRequirements;
    if (!sameTerms(accepted, requirements)) {
      return reject(res, "payment terms do not match this server's requirements", [requirements]);
    }
    const settler = opts.settlers[net.network];
    if (!settler) return reject(res, `no settler configured for ${net.network}`, [requirements]);

    let outcome: SettleOutcome;
    try {
      outcome = await settler.verifyAndSettle(payload, requirements);
    } catch (err) {
      outcome = {
        ok: false,
        reason: err instanceof Error ? err.message.slice(0, 200) : "settlement error",
      };
    }
    if (!outcome.ok) return reject(res, outcome.reason, [requirements]);

    (req as unknown as { payment?: unknown }).payment = {
      verified: true,
      payer: outcome.payer,
      amount: requirements.amount,
      network: outcome.network,
      transaction: outcome.transaction,
    };
    res.setHeader(
      "PAYMENT-RESPONSE",
      encode({
        success: true,
        payer: outcome.payer,
        transaction: outcome.transaction,
        network: outcome.network,
      }),
    );
    next();
  };
}
