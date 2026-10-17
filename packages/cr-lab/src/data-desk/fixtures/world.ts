/**
 * A synthetic Blockworks, for building and testing everything before the key arrives. **Nothing here is Blockworks data**: every name starts `fixture-`, every number is made
 * up by integer arithmetic from a seed, and the same seed always gives the same world. It is built to the SHAPE of the public API (§16.12) and satisfies the identities the
 * tasks' reference solvers will lean on (fees = interest + the other fees; supply is cumulative unlocks; a venue's monthly volume is the sum of its days), so a solver that
 * is right on the fixtures is right on the structure, and a wrong one fails here, not on day 1.
 *
 * Money and amounts are built in integer cents or `bigint` and written as decimal text; no float arithmetic touches a figure.
 */
import { addDays, daysBetween, unixAt } from "../dates.js";

export const FIXTURE_AS_OF = "2026-10-20";
export const FIXTURE_SEED = 20261020;

const fnv = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};
/** A deterministic 32-bit mix of integers: the same inputs always give the same output. */
const mix = (...xs: number[]): number => {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = Math.imul(h ^ x, 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h >>> 0;
};
const draw = (seed: number, key: string, n: number, mod: number): number =>
  mix(seed, fnv(key), n) % mod;

/** `units` as decimal text with `decimals` places, from a bigint count of the smallest unit. */
export function decimalText(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const s = (neg ? -units : units).toString().padStart(decimals + 1, "0");
  const body = decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
  return neg ? `-${body}` : body;
}

const dayNo = (date: string): number => unixAt(date) / 86400;
const uuid = (seed: number, key: string): string => {
  const h = (i: number) => mix(seed, fnv(key), i).toString(16).padStart(8, "0");
  return `${h(1)}-${h(2).slice(0, 4)}-4${h(3).slice(1, 4)}-a${h(4).slice(1, 4)}-${h(5)}${h(6).slice(0, 4)}`;
};

export interface Point {
  /** unix seconds */
  t: number;
  /** decimal text, or null for a figure the source does not report */
  v: Record<string, string | null>;
}

// ---- perp venues ------------------------------------------------------------------------------------------------------------------------------------
const PERP_BASE_USD = [
  5_000_000_000, 3_200_000_000, 1_900_000_000, 1_100_000_000, 600_000_000, 250_000_000, 90_000_000,
  30_000_000,
];

export interface PerpVenue {
  id: string;
  name: string;
  /** null for some venues, as in the real model (8 of 31 on 2026-10-17): `id` is the key, never `slug` */
  slug: string | null;
  projectID: string | null;
  launchDay: string;
}

// ---- lending protocols -------------------------------------------------------------------------------------------------------------------------------
export interface LendingProtocol {
  id: string;
  name: string;
}
const LEND_BASE_CENTS = [
  4_000_000_000, 1_500_000_000, 600_000_000, 250_000_000, 90_000_000, 20_000_000,
];
const LEND_NII_PCT = [22, 18, 25, 15, 30, 20];

// ---- tokens ------------------------------------------------------------------------------------------------------------------------------------------
export interface Token {
  assetID: string;
  slug: string;
  symbol: string;
  name: string;
  /** whole tokens in circulation before the first schedule entry */
  initialSupply: bigint;
  priceMicroUsd: bigint;
  cliffs: { day: string; amount: bigint; recipient: string }[];
  streams: { start: string; end: string; daily: bigint; recipient: string }[];
}

// ---- stablecoin contracts -----------------------------------------------------------------------------------------------------------------------------
export const CHAINS = [
  "fixture-chain-a",
  "fixture-chain-b",
  "fixture-chain-c",
  "fixture-chain-d",
  "fixture-chain-e",
] as const;
export const ISSUERS = [
  "fixture-issuer-1",
  "fixture-issuer-2",
  "fixture-issuer-3",
  "fixture-issuer-4",
] as const;
export interface Contract {
  id: string;
  chain: string;
  issuerID: string;
  networkID: string;
  /** native units (6 decimals) at the as-of date, and the daily change in them */
  baseSupply: bigint;
  dailyDrift: bigint;
  depegFrom?: string;
}

export class FixtureWorld {
  readonly venues: PerpVenue[];
  readonly lending: LendingProtocol[];
  readonly tokens: Token[];
  readonly contracts: Contract[];

  constructor(
    readonly seed: number = FIXTURE_SEED,
    readonly asOf: string = FIXTURE_AS_OF,
  ) {
    this.venues = PERP_BASE_USD.map((_, i) => ({
      id: `fixture-perp-${"abcdefgh"[i]}`,
      name: `Fixture Perp ${"ABCDEFGH"[i]}`,
      slug: i >= 6 ? null : `fixture-perp-${"abcdefgh"[i]}`,
      projectID: i >= 6 ? null : uuid(seed, `perp${i}`),
      launchDay: i === 7 ? addDays(asOf, -200) : addDays(asOf, -900),
    }));
    this.lending = LEND_BASE_CENTS.map((_, i) => ({
      id: `fixture-lend-${i + 1}`,
      name: `Fixture Lend ${i + 1}`,
    }));
    this.tokens = Array.from({ length: 10 }, (_, i) => this.#token(i));
    this.contracts = this.#contracts();
  }

  #token(i: number): Token {
    const key = `token${i}`;
    const slug = `fixture-token-${i + 1}`;
    const cliffs = Array.from({ length: 3 + (i % 4) }, (_, c) => ({
      day: addDays(this.asOf, draw(this.seed, `${key}c${c}`, 0, 520) - 200),
      amount: BigInt(1 + draw(this.seed, `${key}c${c}`, 1, 40)) * 1_000_000n,
      recipient: ["Team", "Investors", "Treasury", "Ecosystem"][c % 4] as string,
    }));
    const streams = Array.from({ length: 1 + (i % 2) }, (_, s) => {
      const start = addDays(this.asOf, draw(this.seed, `${key}s${s}`, 0, 200) - 60);
      return {
        start,
        end: addDays(start, 120 + draw(this.seed, `${key}s${s}`, 1, 400)),
        daily: BigInt(1 + draw(this.seed, `${key}s${s}`, 2, 30)) * 1_000n,
        recipient: ["Team", "Investors"][s % 2] as string,
      };
    });
    return {
      assetID: uuid(this.seed, key),
      slug,
      symbol: `FX${i + 1}`,
      name: `Fixture Token ${i + 1}`,
      initialSupply: BigInt(100 + draw(this.seed, key, 9, 900)) * 1_000_000n,
      priceMicroUsd: BigInt(50_000 + draw(this.seed, key, 8, 5_000_000)),
      cliffs,
      streams,
    };
  }

  #contracts(): Contract[] {
    const out: Contract[] = [];
    let n = 0;
    for (const chain of CHAINS) {
      for (const issuer of ISSUERS) {
        const key = `${chain}/${issuer}`;
        if (draw(this.seed, key, 0, 10) === 0) continue; // some chain x issuer pairs do not exist
        const copies = 1 + (draw(this.seed, key, 1, 4) === 0 ? 1 : 0); // a few pairs have two contracts
        for (let c = 0; c < copies; c++) {
          const base = BigInt(1 + draw(this.seed, `${key}${c}`, 2, 5_000)) * 1_000_000_000_000n; // up to 5e9 tokens, 6 decimals
          const drift =
            ((BigInt(draw(this.seed, `${key}${c}`, 3, 2001)) - 1000n) * (base / 900n)) / 1000n; // up to about 0.11% of the base a day either way: some 10% movers over 90 days
          out.push({
            id: `${chain}_0x${mix(this.seed, fnv(key), c).toString(16).padStart(8, "0")}${(n++).toString(16).padStart(4, "0")}`,
            chain,
            issuerID: issuer,
            networkID: chain,
            baseSupply: base,
            dailyDrift: drift,
          });
        }
      }
    }
    out[2] = { ...(out[2] as Contract), depegFrom: addDays(this.asOf, -9) }; // one contract that has lost its peg
    return out;
  }

  // ---- daily series ----------------------------------------------------------------------------------------------------------------------------------
  /** A perp venue's daily point, or undefined before it launched. One day for one venue is a figure the source does not report (null). */
  perpPoint(v: PerpVenue, day: string): Point | undefined {
    if (daysBetween(v.launchDay, day) < 0) return undefined;
    const i = this.venues.indexOf(v);
    if (i === 2 && day === addDays(this.asOf, -100))
      return { t: unixAt(day), v: { volumeUSD: null } };
    const dollars = Math.floor(
      ((PERP_BASE_USD[i] as number) * (70 + draw(this.seed, v.id, dayNo(day), 61))) / 100,
    );
    return {
      t: unixAt(day),
      v: {
        volumeUSD: `${dollars}.${String(draw(this.seed, v.id, dayNo(day) + 7777, 100)).padStart(2, "0")}`,
      },
    };
  }

  lendingPoint(p: LendingProtocol, day: string): Point {
    const i = this.lending.indexOf(p);
    const interest = BigInt(
      Math.floor(
        ((LEND_BASE_CENTS[i] as number) * (80 + draw(this.seed, p.id, dayNo(day), 41))) / 100,
      ),
    );
    const nii = (interest * BigInt(LEND_NII_PCT[i] as number)) / 100n;
    const flash = i < 3 ? BigInt(draw(this.seed, p.id, dayNo(day) + 1, 5_000_000)) : null;
    const liq = i < 4 ? BigInt(draw(this.seed, p.id, dayNo(day) + 2, 9_000_000)) : null;
    const roy = i === 0 ? BigInt(draw(this.seed, p.id, dayNo(day) + 3, 1_000_000)) : null;
    const extras = (flash ?? 0n) + (liq ?? 0n) + (roy ?? 0n);
    const t = (c: bigint | null) => (c === null ? null : decimalText(c, 2));
    return {
      t: unixAt(day),
      v: {
        "interest-usd": t(interest),
        "net-interest-income-usd": t(nii),
        "flash-loan-fees-usd": t(flash),
        "liquidation-fees-usd": t(liq),
        "royalties-usd": t(roy),
        "fees-usd": t(interest + extras),
        "revenue-usd": t(nii + extras),
      },
    };
  }

  /** Tokens unlocked on `day` (whole-token units with 6 decimals as bigint). */
  unlockedOn(tok: Token, day: string): bigint {
    let a = 0n;
    for (const c of tok.cliffs) if (c.day === day) a += c.amount;
    for (const s of tok.streams)
      if (daysBetween(s.start, day) >= 0 && daysBetween(day, s.end) > 0) a += s.daily;
    return a;
  }

  /** Circulating supply at the end of `day`: the initial supply plus every unlock up to and including it. */
  circulatingAt(tok: Token, day: string): bigint {
    let sum = tok.initialSupply;
    for (const c of tok.cliffs) if (daysBetween(c.day, day) >= 0) sum += c.amount;
    for (const s of tok.streams) {
      const days = Math.max(
        0,
        Math.min(daysBetween(s.start, day) + 1, daysBetween(s.start, s.end)),
      );
      sum += s.daily * BigInt(days);
    }
    return sum;
  }

  /** The first and last days the token's schedule covers: the Token Unlocks API refuses a schedule window that starts outside them. */
  span(tok: Token): { genesis: string; projectedEnd: string } {
    const days = [
      ...tok.cliffs.map((c) => c.day),
      ...tok.streams.flatMap((s) => [s.start, s.end]),
    ].sort();
    return {
      genesis: addDays(days[0] as string, -30),
      projectedEnd: days[days.length - 1] as string,
    };
  }

  /** The aggregate daily amount unlocking by linear streams on `day` (the "daily rate in effect"), in the same units as the cliffs. */
  rateOn(tok: Token, day: string): bigint {
    let r = 0n;
    for (const s of tok.streams)
      if (daysBetween(s.start, day) >= 0 && daysBetween(day, s.end) > 0) r += s.daily;
    return r;
  }

  totalAllocation(tok: Token): bigint {
    return this.circulatingAt(tok, addDays(this.asOf, 5000));
  }

  supplyPoint(tok: Token, day: string): Point {
    return {
      t: unixAt(day),
      v: {
        "circulating-supply": decimalText(this.circulatingAt(tok, day), 6),
        "total-supply": decimalText(this.totalAllocation(tok), 6),
      },
    };
  }

  /** A contract's supply on `day`, in millionths of a token, never below one unit. */
  contractSupply(c: Contract, day: string): bigint {
    const raw = c.baseSupply + c.dailyDrift * BigInt(daysBetween(this.asOf, day));
    return raw < 1n ? 1n : raw;
  }

  /** A contract's price on `day`, in millionths of a dollar: near one dollar, and 0.62 from the day a contract loses its peg. */
  contractPriceMicro(c: Contract, day: string): bigint {
    const depegged = c.depegFrom !== undefined && daysBetween(c.depegFrom, day) >= 0;
    return depegged ? 620_000n : BigInt(999_000 + draw(this.seed, c.id, dayNo(day), 2_000));
  }

  /** Circulating supply in USD (millionths) of a set of contracts on `day`: supply times that day's price, summed. */
  #usd(cs: readonly Contract[], day: string): bigint {
    return cs.reduce(
      (sum, c) =>
        sum + (this.contractSupply(c, day) * this.contractPriceMicro(c, day)) / 1_000_000n,
      0n,
    );
  }

  /** A chain's daily point: the stablecoins deployed on it, summed across issuers. */
  chainPoint(chain: string, day: string): Point | undefined {
    const cs = this.contracts.filter((c) => c.chain === chain);
    if (cs.length === 0) return undefined;
    return {
      t: unixAt(day),
      v: {
        stablecoinCount: String(cs.length),
        circulatingSupplyUSD: decimalText(this.#usd(cs, day), 6),
      },
    };
  }

  /** An issuer's daily point: its stablecoins, summed across chains. */
  issuerPoint(issuer: string, day: string): Point | undefined {
    const cs = this.contracts.filter((c) => c.issuerID === issuer);
    if (cs.length === 0) return undefined;
    return {
      t: unixAt(day),
      v: {
        chainCount: String(new Set(cs.map((c) => c.chain)).size),
        stablecoinCount: String(cs.length),
        circulatingSupplyUSD: decimalText(this.#usd(cs, day), 6),
      },
    };
  }
}
