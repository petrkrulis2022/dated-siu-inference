import { createToolPaywall, type PaywallOptions } from "../paywall.js";
import { PROFILES, type NetworkProfile } from "../networks.js";
import { createSelfSettler, type SelfSettledNetwork, type SelfSettler } from "../self-settled.js";
import { commodityPrintOfRecord } from "../siu-price-402.js";
import { USDC_DECIMALS } from "@touchstone/sdk";
import { githubDataSource } from "./data-source.js";
import type { WorkerEnv } from "./worker-env.js";

/**
 * The three bindings the paywall reads, as plain strings. Not `Pick<WorkerEnv, ...>`: the generated
 * Env types each wrangler var as its string LITERAL, which would make a test (or any other caller)
 * unable to pass a different address — the trap ../env.ts documents.
 */
export interface PaywallBindings {
  TOUCHSTONE_SELLER_ADDRESS: string;
  KITE_SETTLER_PRIVATE_KEY?: string | undefined;
  CIRCLE_LIVE_API_KEY?: string | undefined;
}

/**
 * The paywall options for one profile, from this Worker's bindings. Pure (no network, no I/O) so a
 * test can assert exactly what each profile offers.
 *
 * `onSkipped` is told when a profile's self-settled network is left out because no settler key is
 * configured: the 402 must never advertise a network this Worker cannot settle, since a buyer who
 * signs for it would be refused after the fact.
 */
export function paywallOptionsFor(
  profile: NetworkProfile,
  env: PaywallBindings,
  makeSettler: (network: SelfSettledNetwork, key: string) => SelfSettler = createSelfSettler,
  onSkipped: (network: string) => void = () => undefined,
): PaywallOptions {
  const config = PROFILES[profile];
  const options: PaywallOptions = {
    sellerAddress: env.TOUCHSTONE_SELLER_ADDRESS,
    networks: config.circle.networks,
    facilitatorUrl: config.circle.facilitatorUrl,
    ...(env.CIRCLE_LIVE_API_KEY
      ? { headers: { Authorization: `Bearer ${env.CIRCLE_LIVE_API_KEY}` } }
      : {}),
  };

  if (config.selfSettled.length > 0) {
    const key = env.KITE_SETTLER_PRIVATE_KEY;
    if (!key) {
      for (const n of config.selfSettled) onSkipped(n.network);
    } else {
      options.selfSettled = {
        networks: config.selfSettled,
        settlers: Object.fromEntries(
          config.selfSettled.map((n) => [n.network, makeSettler(n, key)]),
        ),
      };
    }
  }
  return options;
}

type Paywall = ReturnType<typeof createToolPaywall>;

/**
 * The token decimals of every network a profile's 402 offers: USDC's 6 on Circle's networks, each
 * self-settled network's own token otherwise (Kite Testnet's PYUSD has 18). Used to state each
 * offer's amount in mSIU; a network not listed here is simply left unpriced.
 */
export function siuDecimalsFor(profile: NetworkProfile): (network: string) => number | undefined {
  const config = PROFILES[profile];
  const decimals = new Map<string, number>(config.circle.networks.map((n) => [n, USDC_DECIMALS]));
  for (const n of config.selfSettled) decimals.set(n.network, n.decimals);
  return (network) => decimals.get(network);
}

/** `load`, remembered for `ttlMs` per isolate; a failed load is not remembered. */
export function remembered<T>(
  ttlMs: number,
  load: () => Promise<T>,
  clock: () => number = Date.now,
) {
  let value: { v: T; at: number } | undefined;
  return async (): Promise<T> => {
    if (value && clock() - value.at < ttlMs) return value.v;
    const v = await load();
    value = { v, at: clock() };
    return v;
  };
}

// How long one isolate reuses the Commodity print it found for 402 SIU prices. The print changes
// once a day; this only spares a KV read per 402.
const SIU_PRINT_TTL_MS = 5 * 60_000;

function buildPaywall(
  profile: NetworkProfile,
  env: WorkerEnv,
  argumentsAreValid?: (tool: string, args: unknown) => boolean,
): Paywall {
  const options = paywallOptionsFor(profile, env, createSelfSettler, (network) =>
    console.warn(
      `[paywall] ${profile}: not offering ${network}, no KITE_SETTLER_PRIVATE_KEY configured`,
    ),
  );
  options.siuPricing = {
    loadPrint: remembered(SIU_PRINT_TTL_MS, () =>
      commodityPrintOfRecord(githubDataSource(env.PRINTS_CACHE)),
    ),
    decimalsFor: siuDecimalsFor(profile),
  };
  return createToolPaywall(options, argumentsAreValid);
}

// One paywall per profile per isolate: building Circle's middleware is cheap but not free, and a
// request must be able to switch profile without waiting on a rebuild of the others.
const cache = new Map<NetworkProfile, Paywall>();
const restCache = new Map<NetworkProfile, Paywall>();

/** The MCP route's paywall: a paid call whose arguments fail the tool's schema passes through unpaid. */
export function paywallFor(profile: NetworkProfile, env: WorkerEnv): Paywall {
  let paywall = cache.get(profile);
  if (!paywall) {
    paywall = buildPaywall(profile, env);
    cache.set(profile, paywall);
  }
  return paywall;
}

/**
 * The REST routes' paywall: identical prices, networks and settlement, but it always challenges a
 * paid tool. The route (./rest.ts) checks the arguments itself once a payment is attached, so an
 * unpaid probe with no arguments still sees the 402 and a paid call with bad ones is refused
 * before anything settles.
 */
export function restPaywallFor(profile: NetworkProfile, env: WorkerEnv): Paywall {
  let paywall = restCache.get(profile);
  if (!paywall) {
    paywall = buildPaywall(profile, env, () => true);
    restCache.set(profile, paywall);
  }
  return paywall;
}
