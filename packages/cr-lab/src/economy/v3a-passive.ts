/**
 * D149 item 5 (owner, 2026-11-18): the store-of-value measure's passive benchmark, computed from a run's own log.
 *
 * The passive benchmark is the work share an agent would hold at each close had it spent both currencies in proportion to its holdings and made no conversions:
 *  - receipts count as they actually arrived, in the currency the payer chose (a brief's payment, a claim sale's proceeds, a repayment, a default payout), so the
 *    benchmark removes only the agent's own choices, never other agents';
 *  - every spend (a brief or a task escrowed, claims bought from PROVIDER or the roll, a sweep, a repayment, an issuer's cost) is paid from both currencies in proportion
 *    to their value in the passive wallet at that moment, at the window's print and the NAV of the last close;
 *  - an escrow refund returns the passive wallet the same mix it paid into that escrow;
 *  - conversions are not made: buying or selling AGU-lab with the participant, creating or redeeming it, and the forced sales of a sweep. A claim the passive agent keeps
 *    because it made no creation or forced sale counts at face while its window is open and lapses to zero at that window's close, because a passive agent never
 *    presents (D149 amendment, owner, 2026-11-19); a claim it gives up because it made no redemption stops counting against it at the same close, when the agent's own
 *    claim of that window has been presented or lapsed too;
 *  - work claims are otherwise held exactly as the agent held them (bought, received, presented, paid away), so the benchmark isolates the choice between the currencies.
 *
 * The same flows also replay the agent's ACTUAL USDC and AGU-lab, which must equal the `holdings` entry at every close to the base unit. A mismatch means a flow the
 * replay does not know, and the measure that uses this reports n/a with the reason rather than a benchmark built on missing money.
 */
import { asBigInt, type LogEntry } from "./log.js";

export interface PassiveClose {
  agent: string;
  role: string;
  atClose: number;
  workShareBps: bigint | null;
  passiveWorkShareBps: bigint | null;
  workShareBpsShadow: bigint | null;
  passiveWorkShareBpsShadow: bigint | null;
}
/** an agent's own conversions (the participant's buys and sells of AGU-lab, creations, redemptions), by count and by value in µSIU at the time */
export interface Conversions {
  buys: number;
  buyMicroSiu: bigint;
  sells: number;
  sellMicroSiu: bigint;
  creates: number;
  createMicroSiu: bigint;
  redeems: number;
  redeemMicroSiu: bigint;
}
export interface PassiveReplay {
  closes: PassiveClose[];
  mismatches: string[];
  conversions: Map<string, Conversions>;
}

interface Wallet {
  usdc: bigint;
  agu: bigint;
}
interface Passive extends Wallet {
  /** by the window the claims belong to: claims, in µSIU at face, that the passive agent holds beyond the agent's own (positive) or lacks (negative) */
  claimsAdj: Map<number, bigint>;
}

const big = (x: unknown): bigint => asBigInt(x) ?? 0n;
const NONE = (): Conversions => ({ buys: 0, buyMicroSiu: 0n, sells: 0, sellMicroSiu: 0n, creates: 0, createMicroSiu: 0n, redeems: 0, redeemMicroSiu: 0n });

export function replayPassive(log: readonly LogEntry[]): PassiveReplay {
  const actual = new Map<string, Wallet>();
  const passive = new Map<string, Passive>();
  const roles = new Map<string, string>();
  const conversions = new Map<string, Conversions>();
  const closes: PassiveClose[] = [];
  const mismatches: string[] = [];
  const escrows = new Map<string, { payer: string; to: string; asset: "usdc" | "agu"; amount: bigint; paidUsdc: bigint; paidAgu: bigint }>();
  const claimsEscrowPayer = new Map<string, string>();
  let rate = 0n;
  let navNum = 0n;
  let navDen = 0n;

  const isAgent = (a: unknown): a is string => typeof a === "string" && actual.has(a);
  /** the passive agent holds `delta` µSIU more (or less) of window `forWindow`'s claims than the agent; an entry with no window is a log written before the lapse rule */
  const adjustClaims = (a: string, forWindow: unknown, delta: bigint, what: string): void => {
    if (typeof forWindow !== "number") {
      const why = `${a}'s ${what} records no claim window (a log written before the D149 lapse amendment)`;
      if (!mismatches.includes(why)) mismatches.push(why);
      return;
    }
    const adj = (passive.get(a) as Passive).claimsAdj;
    adj.set(forWindow, (adj.get(forWindow) ?? 0n) + delta);
  };
  const usdcValue = (usdc: bigint): bigint => (rate === 0n ? 0n : (usdc * 1_000_000_000n) / rate);
  const aguValue = (agu: bigint): bigint => (navDen === 0n ? 0n : (agu * navNum) / navDen);
  const conv = (a: string): Conversions => {
    let c = conversions.get(a);
    if (c === undefined) conversions.set(a, (c = NONE()));
    return c;
  };
  const move = (a: string, asset: "usdc" | "agu", delta: bigint, alsoPassive: boolean): void => {
    const w = actual.get(a) as Wallet;
    w[asset] += delta;
    if (alsoPassive) (passive.get(a) as Passive)[asset] += delta;
  };
  /** the passive agent pays `value` µSIU from both currencies in proportion to their value now; returns what it paid, in base units */
  const spend = (a: string, value: bigint): Wallet => {
    const p = passive.get(a) as Passive;
    const u = usdcValue(p.usdc);
    const g = aguValue(p.agu);
    if (u + g === 0n || value === 0n) return { usdc: 0n, agu: 0n };
    const fromUsdc = (value * u) / (u + g);
    let usdc = rate === 0n ? 0n : (fromUsdc * rate) / 1_000_000_000n;
    let agu = navNum === 0n ? 0n : ((value - fromUsdc) * navDen) / navNum;
    if (usdc > p.usdc) usdc = p.usdc;
    if (agu > p.agu) agu = p.agu;
    p.usdc -= usdc;
    p.agu -= agu;
    return { usdc, agu };
  };
  const assetOf = (e: LogEntry): "usdc" | "agu" | undefined => (e.usdc !== undefined && e.usdc !== null ? "usdc" : e.agu !== undefined && e.agu !== null ? "agu" : undefined);
  const valueOf = (asset: "usdc" | "agu", amount: bigint): bigint => (asset === "usdc" ? usdcValue(amount) : aguValue(amount));

  for (const e of log) {
    switch (e.kind) {
      case "price":
        if (typeof e.atWindow === "number" && e.commodity !== undefined) rate = big(e.commodity);
        break;
      case "holdings": {
        if (e.rate === undefined || e.navNum === undefined || e.navDen === undefined) {
          const why = `holdings at close ${String(e.atClose)} carry no valuation (a log written before D149)`;
          if (!mismatches.includes(why)) mismatches.push(why);
          break;
        }
        rate = big(e.rate);
        navNum = big(e.navNum);
        navDen = big(e.navDen);
        const a = e.actor;
        const usdc = big(e.usdc);
        const agu = big(e.agu);
        if (e.atClose === 0) {
          actual.set(a, { usdc, agu });
          passive.set(a, { usdc, agu, claimsAdj: new Map() });
          roles.set(a, String(e.role));
        }
        const w = actual.get(a);
        if (w === undefined) break;
        if (w.usdc !== usdc || w.agu !== agu)
          mismatches.push(`${a} at close ${String(e.atClose)}: replayed ${w.usdc} µ$ USDC and ${w.agu} AGU-lab units, logged ${usdc} and ${agu}`);
        const p = passive.get(a) as Passive;
        // a window's claims settle at its close, before the holdings are logged: the passive agent's lapse then, worthless, and its missing ones are gone from the agent too
        const k = Number(e.atClose);
        for (const w of [...p.claimsAdj.keys()]) if (w <= k) p.claimsAdj.delete(w);
        const adjusted = big(e.claimsMicroSiu) + [...p.claimsAdj.values()].reduce((n, v) => n + v, 0n);
        const claims = adjusted > 0n ? adjusted : 0n;
        const shadowPpm = e.shadowPpm === undefined ? 1_000_000n : big(e.shadowPpm);
        const pu = usdcValue(p.usdc);
        const pg = aguValue(p.agu);
        const pgShadow = (pg * shadowPpm) / 1_000_000n;
        const share = (work: bigint, total: bigint): bigint | null => (total === 0n ? null : (work * 10_000n) / total);
        closes.push({
          agent: a,
          role: roles.get(a) ?? String(e.role),
          atClose: Number(e.atClose),
          workShareBps: e.workShareBps === null || e.workShareBps === undefined ? null : big(e.workShareBps),
          passiveWorkShareBps: share(pg + claims, pu + pg + claims),
          workShareBpsShadow: e.workShareBpsShadow === null || e.workShareBpsShadow === undefined ? null : big(e.workShareBpsShadow),
          passiveWorkShareBpsShadow: share(pgShadow + claims, pu + pgShadow + claims),
        });
        break;
      }
      // ---- conversions: the actual wallet changes, the passive one does not ----
      case "participant-sell":
        if (e.genesis === true || !isAgent(e.to)) break;
        move(e.to, "usdc", -big(e.usdc), false);
        move(e.to, "agu", big(e.agu), false);
        conv(e.to).buys++;
        conv(e.to).buyMicroSiu += aguValue(big(e.agu));
        break;
      case "participant-buyback":
        if (!isAgent(e.from)) break;
        move(e.from, "agu", -big(e.agu), false);
        move(e.from, "usdc", big(e.usdc), false);
        // a roll purchase paid in AGU-lab (its spend is the roll sale below) and a sweep's forced sale are not the agent's own conversions
        if (e.forPurchase === undefined && e.forced === undefined) {
          conv(e.from).sells++;
          conv(e.from).sellMicroSiu += aguValue(big(e.agu));
        }
        break;
      case "create":
        if (!isAgent(e.actor) || e.inKindBy === undefined) break;
        move(e.actor, "agu", big(e.agu), false);
        adjustClaims(e.actor, e.forWindow, big(e.milli) * 1_000n, `create of ${String(e.tokenId)}`);
        conv(e.actor).creates++;
        conv(e.actor).createMicroSiu += big(e.milli) * 1_000n;
        break;
      case "redeem": {
        if (!isAgent(e.actor)) break;
        move(e.actor, "agu", -big(e.agu), false);
        const lots = (e.lots as { tokenId?: unknown; milli?: unknown; forWindow?: unknown }[] | undefined) ?? [];
        const face = lots.reduce((n, l) => n + big(l.milli) * 1_000n, 0n);
        for (const l of lots) adjustClaims(e.actor, l.forWindow, -big(l.milli) * 1_000n, `redemption of ${String(l.tokenId)}`);
        conv(e.actor).redeems++;
        conv(e.actor).redeemMicroSiu += face;
        break;
      }
      // ---- spends, receipts and refunds ----
      case "escrow-open": {
        const asset = assetOf(e);
        if (!isAgent(e.actor) || asset === undefined) break;
        const amount = big(e[asset]);
        move(e.actor, asset, -amount, false);
        const paid = spend(e.actor, valueOf(asset, amount));
        escrows.set(String(e.escrow), { payer: e.actor, to: String(e.to), asset, amount, paidUsdc: paid.usdc, paidAgu: paid.agu });
        break;
      }
      case "escrow-settle": {
        const x = escrows.get(String(e.escrow));
        if (x === undefined) break;
        const paid = big(e.paid);
        const refunded = big(e.refunded);
        if (isAgent(x.to) && paid > 0n) move(x.to, x.asset, paid, true);
        if (refunded > 0n) {
          move(x.payer, x.asset, refunded, false);
          const p = passive.get(x.payer) as Passive;
          p.usdc += (x.paidUsdc * refunded) / x.amount;
          p.agu += (x.paidAgu * refunded) / x.amount;
        }
        break;
      }
      case "claim-mint": {
        // buy_offer: the buyer pays PROVIDER directly
        const asset = assetOf(e);
        if (!isAgent(e.actor) || asset === undefined || e.offer === undefined) break;
        const amount = big(e[asset]);
        move(e.actor, asset, -amount, false);
        spend(e.actor, valueOf(asset, amount));
        const provider = [...roles].find(([, r]) => r === "provider")?.[0];
        if (provider !== undefined) move(provider, asset, amount, true);
        break;
      }
      case "roll-sale":
        if (!isAgent(e.to)) break;
        move(e.to, "usdc", -big(e.usdc), false);
        spend(e.to, usdcValue(big(e.usdc)));
        break;
      case "sweep":
        if (!isAgent(e.actor)) break;
        move(e.actor, "usdc", -big(e.usdc), false);
        spend(e.actor, usdcValue(big(e.usdc)));
        break;
      case "claim-transfer":
        if (typeof e.to === "string" && e.to.startsWith("claims-escrow:") && isAgent(e.from)) claimsEscrowPayer.set(e.to, e.from);
        // a sweep's forced sale of claims: the agent gets USDC, the passive agent keeps the claims, at face (Commodity µSIU, as the holdings value them) until they lapse
        if (e.forced === "sweep" && isAgent(e.from)) {
          move(e.from, "usdc", big(e.usdc), false);
          if (e.microSiu === undefined) adjustClaims(e.from, undefined, 0n, `forced sale of ${String(e.tokenId)}`);
          else adjustClaims(e.from, e.forWindow, big(e.microSiu), `forced sale of ${String(e.tokenId)}`);
        }
        break;
      case "wallet-transfer": {
        const asset = assetOf(e);
        if (!isAgent(e.actor) || asset === undefined) break;
        const amount = big(e[asset]);
        move(e.actor, asset, -amount, false);
        spend(e.actor, valueOf(asset, amount));
        if (isAgent(e.to)) move(e.to, asset, amount, true);
        break;
      }
      case "claim-close":
        if (isAgent(e.holder) && big(e.usdc) > 0n) move(e.holder, "usdc", big(e.usdc), true);
        break;
      case "receipt":
        // a default payout held with claims paid for a brief goes back to the payer when the brief lapses
        if (e.defaultPayoutToPayer !== undefined && big(e.defaultPayoutToPayer) > 0n && typeof e.brief === "string") {
          const payer = claimsEscrowPayer.get(`claims-escrow:${e.brief}`);
          if (payer !== undefined && isAgent(payer)) move(payer, "usdc", big(e.defaultPayoutToPayer), true);
        }
        break;
      case "data-purchase": {
        // logs from before D148 only
        const asset = assetOf(e);
        if (!isAgent(e.actor) || asset === undefined) break;
        move(e.actor, asset, -big(e[asset]), false);
        spend(e.actor, valueOf(asset, big(e[asset])));
        break;
      }
      default:
        break;
    }
  }
  return { closes, mismatches, conversions };
}
