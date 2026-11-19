import type { D1Database } from "@cloudflare/workers-types";

/**
 * The bindings this Worker reads beyond the ones `worker-configuration.d.ts` generates from
 * wrangler.jsonc. Declared here, not in that generated file: secrets never appear in wrangler.jsonc,
 * and the generated file types each var as the string LITERAL in the config (see ../env.ts's note on
 * why that hardens one deployment's values into the signature). Everything here is optional on
 * purpose — a missing optional binding turns its feature off (a profile that needs a settler key
 * simply does not offer that network), it never crashes a request.
 */
export type WorkerEnv = Env & {
  /** Default network profile when the KV flag is unset: "mainnet" | "testnet" | "base-sepolia". Unknown → testnet. */
  TOUCHSTONE_NETWORK_PROFILE?: string;
  /**
   * The gas-paying key for payments this Worker settles itself (Kite). A Worker secret the owner sets
   * (`wrangler secret put KITE_SETTLER_PRIVATE_KEY`); it pays gas only — a payment moves funds buyer →
   * payTo in one transaction, so this key never holds, receives or can redirect revenue.
   */
  KITE_SETTLER_PRIVATE_KEY?: string;
  /** Circle's Console API key, sent to Circle's Gateway as a bearer token if set. Worker secret. */
  CIRCLE_LIVE_API_KEY?: string;
  /** The settlement log (D1 `touchstone-settlements`); absent means payments are simply not logged. */
  SETTLEMENTS?: D1Database;
};
