import { KITE_TESTNET, type SelfSettledNetwork } from "./self-settled.js";

/**
 * Which networks the paid tools accept payment on — mainnet-switch brief §2A and decision 5.
 *
 *  - `mainnet`      Base (8453) and Arc (5042) through Circle's live Gateway. Kite (2366), settled by
 *                   this server itself (Circle's Gateway does not cover Kite), is held back until its
 *                   settler is funded and tested — see the profile below.
 *  - `testnet`      Base Sepolia (84532) and Arc Testnet (5042002) through Circle's testnet Gateway,
 *                   Kite Testnet (2368) settled by this server.
 *  - `base-sepolia` Exactly the pre-switch behaviour: Base Sepolia only, through Circle's testnet
 *                   Gateway. The rollback target ("flipping the flag back restores the old
 *                   behaviour without redeploying anything else", brief §12) and the lab's profile.
 *
 * The profile is a flag read on every request (see `resolveProfile`), so switching needs no deploy.
 */
export type NetworkProfile = "mainnet" | "testnet" | "base-sepolia";

export const NETWORK_PROFILES: readonly NetworkProfile[] = ["mainnet", "testnet", "base-sepolia"];

/** The KV key (in the PRINTS_CACHE namespace) holding the live profile; absent means "use the env default". */
export const PROFILE_KV_KEY = "config:network-profile";

/** What an unreadable or invalid flag falls back to: never mainnet. Real money moves only on an explicit "mainnet". */
export const SAFE_FALLBACK_PROFILE: NetworkProfile = "testnet";

export interface ProfileConfig {
  profile: NetworkProfile;
  /** Networks Circle's Gateway (Nanopayments, batched) settles, as CAIP-2 ids, and the Gateway to ask. */
  circle: { networks: string[]; facilitatorUrl: string };
  /** Networks this server verifies and settles itself. */
  selfSettled: SelfSettledNetwork[];
  /** Tools held back from payment on this profile, with the reason a caller is shown instead. */
  unavailableTools: Record<string, string>;
}

const CIRCLE_MAINNET = "https://gateway-api.circle.com";
const CIRCLE_TESTNET = "https://gateway-api-testnet.circle.com";

export const PROFILES: Record<NetworkProfile, ProfileConfig> = {
  mainnet: {
    profile: "mainnet",
    // CAIP-2 ids confirmed against Circle's live `GET /v1/x402/supported` on 2026-10-25
    circle: { networks: ["eip155:8453", "eip155:5042"], facilitatorUrl: CIRCLE_MAINNET },
    // Kite mainnet (KITE_MAINNET, built and testnet-proven) is held back: owner's decision of
    // 2026-11-26 to go live on Base and Arc first. It returns here, with a deploy, once its settler
    // holds KITE and Kite's own paid tests pass; until then no 402 or OpenAPI document names it.
    selfSettled: [],
    unavailableTools: {
      verify_receipt:
        "verify_receipt is not available on mainnet yet: it reads escrow-backed settlements, which exist on testnet only, " +
        "and mainnet receipt attestation is not built. You were not charged.",
    },
  },
  testnet: {
    profile: "testnet",
    circle: { networks: ["eip155:84532", "eip155:5042002"], facilitatorUrl: CIRCLE_TESTNET },
    selfSettled: [KITE_TESTNET],
    unavailableTools: {},
  },
  "base-sepolia": {
    profile: "base-sepolia",
    circle: { networks: ["eip155:84532"], facilitatorUrl: CIRCLE_TESTNET },
    selfSettled: [],
    unavailableTools: {},
  },
};

export function parseProfile(raw: unknown): NetworkProfile | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  return (NETWORK_PROFILES as readonly string[]).includes(v) ? (v as NetworkProfile) : undefined;
}

/** The slice of a KV namespace this needs, so tests can pass a plain object. */
export interface KvReader {
  get(key: string): Promise<string | null>;
}

/**
 * The profile for THIS request: the KV flag if it holds a valid value, otherwise the env default if
 * valid, otherwise `testnet`. A KV outage, a typo and a missing key all land on a testnet profile —
 * the only way to reach `mainnet` is for something to have said "mainnet" explicitly and correctly.
 */
export async function resolveProfile(
  kv: KvReader | undefined,
  envDefault: string | undefined,
): Promise<NetworkProfile> {
  if (kv) {
    try {
      const fromKv = parseProfile(await kv.get(PROFILE_KV_KEY));
      if (fromKv) return fromKv;
    } catch {
      // fall through to the default: a flag we cannot read is not a reason to fail the request
    }
  }
  return parseProfile(envDefault) ?? SAFE_FALLBACK_PROFILE;
}
