/**
 * D149 item 5 (owner, 2026-11-18): the store-of-value measure's passive benchmark, computed from a run's own log.
 *
 * Two benchmarks (`Benchmark` below). D151 (owner, 2026-11-19) scores the HOLDING one: each payment in the agent's own currency, no conversions, and a claim the agent
 * bought counts only while held unused (the passive agent holds the money instead, and pays when the claim is used). D149's PRO-RATA one, described in the rest of
 * this comment, is reported beside it as the spending-mix effect, never scored. Everything below about receipts, refunds, sweeps, conversions and lapses holds for both.
 *
 * The pro-rata benchmark is the work share an agent would hold at each close had it spent both currencies in proportion to its holdings and made no conversions:
 *  - receipts count as they actually arrived, in the currency the payer chose (a brief's payment, a claim sale's proceeds, a repayment, a default payout), so the
 *    benchmark removes only the agent's own choices, never other agents';
 *  - every spend (a brief or a task escrowed, claims bought from PROVIDER or the roll, a repayment, an issuer's cost) is paid from both currencies in proportion
 *    to their value in the passive wallet at that moment, at the window's print and the NAV of the last close;
 *  - a sweep (the owner's fixed dollar demand) is paid as the engine pays it: USDC first, AGU-lab at the bid only for a shortfall, then the claims the passive agent kept
 *    (D150 item 2, owner, 2026-11-19 -- paying it pro rata was itself a conversion);
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
import { participantBid } from "./participant.js";

export interface PassiveClose {
  agent: string;
  role: string;
  atClose: number;
  workShareBps: bigint | null;
  passiveWorkShareBps: bigint | null;
  workShareBpsShadow: bigint | null;
  passiveWorkShareBpsShadow: bigint | null;
  /**
   * D152 (owner, 2026-11-20): value held in work -- AGU-lab at NAV plus live claims at face, Commodity µSIU -- for the agent and the passive agent, and the agent's
   * starting value (everything it held at close 0, valued then). Store of value is (work − passive work) ÷ start: a lapsed claim is 0 on both sides, never holding.
   */
  workMicroSiu: bigint;
  passiveWorkMicroSiu: bigint;
  workMicroSiuShadow: bigint;
  passiveWorkMicroSiuShadow: bigint;
  startMicroSiu: bigint;
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
/** an agent's claim purchases and what became of them (D151): used (served on a pass, or paid away for a brief), or closed unused (lapsed, defaulted, created, sold) */
export interface ClaimHolds {
  bought: number;
  boughtMilli: bigint;
  usedMilli: bigint;
  closedUnusedMilli: bigint;
}
export interface PassiveReplay {
  closes: PassiveClose[];
  mismatches: string[];
  conversions: Map<string, Conversions>;
  /** D151: each agent's claim purchases (both benchmarks count them; only the holding benchmark treats the unused ones as a holding choice) */
  claimHolds: Map<string, ClaimHolds>;
  /** D151, holding benchmark: payments the passive agent could not make in the agent's currency and paid from the other at value, in µSIU */
  shortfalls: { agent: string; what: string; microSiu: bigint }[];
}
/**
 * Which passive benchmark (D151, owner, 2026-11-19):
 *  - `holding` -- scored: each payment in the currency the agent paid it in, no conversions, and a claim the agent bought counts only while it is held unused (the
 *    passive agent holds the purchase money instead, and pays it when the agent uses the claim). The difference then measures deliberate holding choices only.
 *  - `pro-rata` -- D149's benchmark (with D150's sweep rule): every payment from both currencies in proportion to holdings. Since D151 it is reported beside the verdict
 *    as the spending-mix effect, descriptive and never scored: paying in one currency moves it mechanically, and the exchange measure already covers payments.
 */
export type Benchmark = "holding" | "pro-rata";

interface Wallet {
  usdc: bigint;
  agu: bigint;
}
interface Passive extends Wallet {
  /** by the window the claims belong to: claims, in µSIU at face, that the passive agent holds beyond the agent's own (positive) or lacks (negative) */
  claimsAdj: Map<number, bigint>;
}
/** D151: a claim purchase the passive agent has not made (yet): it holds `amount` of `asset` instead of `milli` of the claim, until the agent uses or closes it */
interface Lot {
  tokenId: string;
  milli: bigint;
  asset: "usdc" | "agu";
  amount: bigint;
  forWindow: number;
  series: string;
}
/** what a used lot cost the passive agent, in each currency, so a claim returned unused from a claim escrow refunds exactly that */
interface UsedSlice {
  payer: string;
  lot: Lot;
  paid: Wallet;
}

const big = (x: unknown): bigint => asBigInt(x) ?? 0n;
const NONE = (): Conversions => ({ buys: 0, buyMicroSiu: 0n, sells: 0, sellMicroSiu: 0n, creates: 0, createMicroSiu: 0n, redeems: 0, redeemMicroSiu: 0n });

export function replayPassive(log: readonly LogEntry[], benchmark: Benchmark): PassiveReplay {
  const holding = benchmark === "holding";
  const pending = new Map<string, Lot[]>();
  const escrowSlices = new Map<string, UsedSlice[]>();
  const claimHolds = new Map<string, ClaimHolds>();
  const shortfalls: PassiveReplay["shortfalls"] = [];
  /** the window the last price entry opened: the roll sells front claims for it */
  let currentWindow: number | undefined;
  const aguLegForPurchase = new Map<string, bigint>();
  let frontierRate = 0n;
  const actual = new Map<string, Wallet>();
  const passive = new Map<string, Passive>();
  const roles = new Map<string, string>();
  const startValue = new Map<string, bigint>();
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
  const holds = (a: string): ClaimHolds => {
    let h = claimHolds.get(a);
    if (h === undefined) claimHolds.set(a, (h = { bought: 0, boughtMilli: 0n, usedMilli: 0n, closedUnusedMilli: 0n }));
    return h;
  };
  /**
   * D151, holding benchmark: the passive agent pays `amount` in `asset`, the currency the agent used. If it holds too little of it (only after a conversion it did not
   * make), it pays the rest from the other currency at value -- the window's print and the last close's NAV, no spread -- and the shortfall is reported.
   */
  const payIn = (a: string, asset: "usdc" | "agu", amount: bigint, what: string): Wallet => {
    const p = passive.get(a) as Passive;
    const paid: Wallet = { usdc: 0n, agu: 0n };
    const from = p[asset] < amount ? p[asset] : amount;
    p[asset] -= from;
    paid[asset] = from;
    const rest = amount - from;
    if (rest > 0n) {
      const value = valueOf(asset, rest);
      const other = asset === "usdc" ? "agu" : "usdc";
      let units = other === "usdc" ? (rate === 0n ? 0n : (value * rate) / 1_000_000_000n) : navNum === 0n ? 0n : (value * navDen) / navNum;
      if (units > p[other]) units = p[other];
      p[other] -= units;
      paid[other] = units;
      shortfalls.push({ agent: a, what, microSiu: value });
    }
    return paid;
  };
  /** D151: up to `milli` of `a`'s unbought lots of `tokenId`, oldest first, each with its share of the money; the lots shrink by what is taken */
  const takeLots = (a: string, tokenId: string, milli: bigint): Lot[] => {
    const out: Lot[] = [];
    let left = milli;
    for (const lot of pending.get(a) ?? []) {
      if (left === 0n) break;
      if (lot.tokenId !== tokenId || lot.milli === 0n) continue;
      const m = lot.milli < left ? lot.milli : left;
      const amount = m === lot.milli ? lot.amount : (lot.amount * m) / lot.milli;
      out.push({ ...lot, milli: m, amount });
      lot.milli -= m;
      lot.amount -= amount;
      left -= m;
    }
    pending.set(a, (pending.get(a) ?? []).filter((l) => l.milli > 0n));
    return out;
  };
  const taken = (lots: Lot[]): bigint => lots.reduce((n, l) => n + l.milli, 0n);
  /** the agent used a bought claim: the passive agent buys it now, at its price, in the currency the agent paid */
  const useLots = (a: string, lots: Lot[], what: string): UsedSlice[] =>
    lots.map((lot) => {
      holds(a).usedMilli += lot.milli;
      return { payer: a, lot, paid: payIn(a, lot.asset, lot.amount, what) };
    });
  /** a bought claim closed unused (lapsed, defaulted, created, sold): the passive agent never bought it and keeps the money */
  const closeLots = (a: string, lots: Lot[]): void => {
    if (lots.length > 0) holds(a).closedUnusedMilli += taken(lots);
  };
  /** a payment by the agent, mirrored by the passive agent: in the agent's own currency (holding benchmark) or pro rata (D149) */
  const pay = (a: string, asset: "usdc" | "agu", amount: bigint, what: string): Wallet =>
    holding ? payIn(a, asset, amount, what) : spend(a, valueOf(asset, amount));
  /** Commodity µSIU at face of `milli` of a claim in `series`, at the latest prints, as the holdings value it (`World.claimsValueMicroSiu`) */
  const face = (milli: bigint, series: string): bigint | undefined =>
    series === "commodity" ? milli * 1_000n : frontierRate === 0n || rate === 0n ? undefined : (milli * 1_000n * frontierRate) / rate;
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
  /**
   * D150 item 2 (owner, 2026-11-19): the passive agent pays its owner's sweep -- a fixed dollar demand -- exactly as the engine pays the agent's (`World.#v3aSweep`): from
   * USDC first; if that is short, the fewest AGU-lab units whose bid covers the rest, at the terms the sweep logged; then the claims it kept instead of a creation or a
   * forced sale, soonest window first, at the participant's bid on face. Paying it pro rata, as D149 did, was itself a conversion the passive agent never makes, and moved
   * every demand agent's difference by the sweep alone. Anything still unpaid stays unpaid when the agent's own sweep was short too (neither has anything left to
   * sell); otherwise the rest would come from claims the agent holds, which the replay does not track, and the measure reports n/a with the reason.
   */
  const paySweep = (e: LogEntry): void => {
    const a = e.actor;
    const p = passive.get(a) as Passive;
    const demanded = asBigInt(e.demanded);
    const where = `at close ${String(e.atClose ?? e.window)}`;
    if (demanded === undefined) {
      const why = `${a}'s sweep ${where} records no demand (a log written before D143)`;
      if (!mismatches.includes(why)) mismatches.push(why);
      return;
    }
    const fromUsdc = p.usdc < demanded ? p.usdc : demanded;
    p.usdc -= fromUsdc;
    let short = demanded - fromUsdc;
    if (short === 0n) return;
    const sweepRate = asBigInt(e.rate);
    const num = asBigInt(e.navNum);
    const den = asBigInt(e.navDen);
    const spreadBps = asBigInt(e.spreadBps);
    const atClose = typeof e.atClose === "number" ? e.atClose : undefined;
    if (sweepRate === undefined || num === undefined || den === undefined || spreadBps === undefined || atClose === undefined) {
      if (p.agu > 0n || [...p.claimsAdj.values()].some((v) => v > 0n)) {
        const why = `${a}'s sweep ${where} needs AGU-lab sold in the passive benchmark, but records no bid terms (a log written before the D150 sweep fix)`;
        if (!mismatches.includes(why)) mismatches.push(why);
      }
      return;
    }
    // AGU-lab at the bid: the fewest units whose bid covers the shortfall, or all of it
    if (p.agu > 0n && num > 0n && den > 0n) {
      const bid = (units: bigint): bigint => participantBid(units, num, den, sweepRate, spreadBps);
      let units = p.agu;
      if (bid(units) >= short) {
        let lo = 0n;
        while (lo + 1n < units) {
          const mid = (lo + units) / 2n;
          if (bid(mid) >= short) units = mid;
          else lo = mid;
        }
      }
      const got = bid(units);
      p.agu -= units;
      const paid = got < short ? got : short;
      p.usdc += got - paid;
      short -= paid;
    }
    // the claims it kept, soonest window first, at the bid on face: floor(µSIU × rate × (20,000 − spread) ÷ (1e9 × 20,000)), as the engine's claim tier
    const keep = 20_000n - spreadBps;
    for (const w of [...p.claimsAdj.keys()].filter((w) => w > atClose).sort((x, y) => x - y)) {
      if (short === 0n) break;
      const held = p.claimsAdj.get(w) ?? 0n;
      if (held <= 0n) continue;
      const bid = (micro: bigint): bigint => (micro * sweepRate * keep) / (1_000_000_000n * 20_000n);
      let micro = (short * 1_000_000_000n * 20_000n + sweepRate * keep - 1n) / (sweepRate * keep);
      if (micro > held) micro = held;
      const got = bid(micro);
      p.claimsAdj.set(w, held - micro);
      const paid = got < short ? got : short;
      p.usdc += got - paid;
      short -= paid;
    }
    if (short > 0n && (asBigInt(e.shortfall) ?? 0n) === 0n)
      mismatches.push(
        `${a}'s passive benchmark is ${short} µ$ short of its owner's sweep ${where} after its USDC, AGU-lab and the claims it kept, while the agent paid in full: the rest would come from claims the replay does not track`,
      );
  };
  const assetOf = (e: LogEntry): "usdc" | "agu" | undefined => (e.usdc !== undefined && e.usdc !== null ? "usdc" : e.agu !== undefined && e.agu !== null ? "agu" : undefined);
  const valueOf = (asset: "usdc" | "agu", amount: bigint): bigint => (asset === "usdc" ? usdcValue(amount) : aguValue(amount));

  for (const e of log) {
    switch (e.kind) {
      case "price":
        if (typeof e.atWindow === "number" && e.commodity !== undefined) rate = big(e.commodity);
        if (typeof e.atWindow === "number" && e.frontier !== undefined) frontierRate = big(e.frontier);
        if (typeof e.atWindow === "number") currentWindow = e.atWindow;
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
        // D151: a claim the agent bought and still holds unused is its holding choice; the passive agent holds the purchase money instead, so it lacks the claim
        let lacking = 0n;
        if (holding) {
          const lots = pending.get(a) ?? [];
          for (const l of lots) if (l.forWindow <= k) closeLots(a, [l]);
          pending.set(a, lots.filter((l) => l.forWindow > k));
          const byToken = new Map<string, { milli: bigint; series: string }>();
          for (const l of pending.get(a) ?? []) byToken.set(l.tokenId, { milli: (byToken.get(l.tokenId)?.milli ?? 0n) + l.milli, series: l.series });
          for (const [tokenId, t] of byToken) {
            const f = face(t.milli, t.series);
            if (f === undefined) {
              const why = `${a}'s unbought claim ${tokenId} at close ${k} has no ${t.series} print to value it`;
              if (!mismatches.includes(why)) mismatches.push(why);
            } else lacking += f;
          }
        }
        const adjusted = big(e.claimsMicroSiu) + [...p.claimsAdj.values()].reduce((n, v) => n + v, 0n) - lacking;
        const claims = adjusted > 0n ? adjusted : 0n;
        const shadowPpm = e.shadowPpm === undefined ? 1_000_000n : big(e.shadowPpm);
        const pu = usdcValue(p.usdc);
        const pg = aguValue(p.agu);
        const pgShadow = (pg * shadowPpm) / 1_000_000n;
        const share = (work: bigint, total: bigint): bigint | null => (total === 0n ? null : (work * 10_000n) / total);
        // D152: value held in work, both sides valued with the same formula at this close; the starting value is everything the agent held at close 0
        const aw = aguValue(agu);
        const agentClaims = big(e.claimsMicroSiu);
        if (e.atClose === 0) startValue.set(a, usdcValue(usdc) + aw + agentClaims);
        closes.push({
          workMicroSiu: aw + agentClaims,
          passiveWorkMicroSiu: pg + claims,
          workMicroSiuShadow: (aw * shadowPpm) / 1_000_000n + agentClaims,
          passiveWorkMicroSiuShadow: pgShadow + claims,
          startMicroSiu: startValue.get(a) ?? 0n,
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
        // D151: a roll purchase paid in AGU-lab is a purchase in AGU-lab
        if (e.forPurchase === "front-claim-order") aguLegForPurchase.set(e.from, (aguLegForPurchase.get(e.from) ?? 0n) + big(e.agu));
        // a roll purchase paid in AGU-lab (its spend is the roll sale below) and a sweep's forced sale are not the agent's own conversions
        if (e.forPurchase === undefined && e.forced === undefined) {
          conv(e.from).sells++;
          conv(e.from).sellMicroSiu += aguValue(big(e.agu));
        }
        break;
      case "create":
        if (!isAgent(e.actor) || e.inKindBy === undefined) break;
        move(e.actor, "agu", big(e.agu), false);
        {
          // D151: a bought claim the agent creates with closes unused (the passive agent never bought it and keeps the money); any other claim it keeps, as D149
          const t = holding ? takeLots(e.actor, String(e.tokenId), big(e.milli)) : [];
          closeLots(e.actor, t);
          const kept = big(e.milli) - taken(t);
          if (kept > 0n || !holding) adjustClaims(e.actor, e.forWindow, kept * 1_000n, `create of ${String(e.tokenId)}`);
        }
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
        const paid = pay(e.actor, asset, amount, `escrow-open of ${String(e.quote ?? e.escrow)}`);
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
        holds(e.actor).bought++;
        holds(e.actor).boughtMilli += big(e.milli);
        // D151: the passive agent does not buy the claim; it holds the money until the agent uses the claim, and keeps it if the claim closes unused
        if (holding) {
          if (typeof e.forWindow !== "number" || typeof e.series !== "string") mismatches.push(`${e.actor}'s claim purchase ${String(e.tokenId)} records no window or series`);
          else pending.set(e.actor, [...(pending.get(e.actor) ?? []), { tokenId: String(e.tokenId), milli: big(e.milli), asset, amount, forWindow: e.forWindow, series: e.series }]);
        } else spend(e.actor, valueOf(asset, amount));
        const provider = [...roles].find(([, r]) => r === "provider")?.[0];
        if (provider !== undefined) move(provider, asset, amount, true);
        break;
      }
      case "roll-sale": {
        if (!isAgent(e.to)) break;
        move(e.to, "usdc", -big(e.usdc), false);
        holds(e.to).bought++;
        holds(e.to).boughtMilli += big(e.milli);
        if (!holding) {
          spend(e.to, usdcValue(big(e.usdc)));
          break;
        }
        // D151: paid in USDC, or in AGU-lab through the participant just before (the roll's AGU-lab leg)
        const leg = aguLegForPurchase.get(e.to);
        aguLegForPurchase.delete(e.to);
        // a front claim is presentable in the roll's own window (the window the last price entry opened), and the AGU-lab reserve holds Commodity claims only
        if (currentWindow === undefined) mismatches.push(`${e.to}'s front claim ${String(e.tokenId)}: no window recorded before it`);
        else
          pending.set(e.to, [
            ...(pending.get(e.to) ?? []),
            { tokenId: String(e.tokenId), milli: big(e.milli), asset: leg !== undefined ? "agu" : "usdc", amount: leg ?? big(e.usdc), forWindow: currentWindow, series: "commodity" },
          ]);
        break;
      }
      case "sweep":
        if (!isAgent(e.actor)) break;
        move(e.actor, "usdc", -big(e.usdc), false);
        paySweep(e);
        break;
      case "claim-transfer": {
        const tokenId = String(e.tokenId);
        const milli = big(e.milli);
        if (typeof e.to === "string" && e.to.startsWith("claims-escrow:") && isAgent(e.from)) {
          claimsEscrowPayer.set(e.to, e.from);
          // D151: a bought claim paid into a brief's claim escrow is used: the passive agent buys it now, as the agent paid for it
          if (holding) escrowSlices.set(e.to, [...(escrowSlices.get(e.to) ?? []), ...useLots(e.from, takeLots(e.from, tokenId, milli), `claim payment into ${e.to}`)]);
        }
        // D151: a bought claim returned unused from a claim escrow refunds the passive agent what it paid, and is held unused again
        if (holding && typeof e.from === "string" && e.from.startsWith("claims-escrow:") && isAgent(e.to) && e.settlement === "returned") {
          let left = milli;
          for (const s of escrowSlices.get(e.from) ?? []) {
            if (left === 0n) break;
            if (s.payer !== e.to || s.lot.tokenId !== tokenId || s.lot.milli === 0n) continue;
            const m = s.lot.milli < left ? s.lot.milli : left;
            const back = (x: bigint): bigint => (m === s.lot.milli ? x : (x * m) / s.lot.milli);
            const refund = { usdc: back(s.paid.usdc), agu: back(s.paid.agu) };
            const p = passive.get(e.to) as Passive;
            p.usdc += refund.usdc;
            p.agu += refund.agu;
            const amount = back(s.lot.amount);
            pending.set(e.to, [...(pending.get(e.to) ?? []), { ...s.lot, milli: m, amount }]);
            s.lot = { ...s.lot, milli: s.lot.milli - m, amount: s.lot.amount - amount };
            s.paid = { usdc: s.paid.usdc - refund.usdc, agu: s.paid.agu - refund.agu };
            holds(e.to).usedMilli -= m;
            left -= m;
          }
        }
        // a sweep's forced sale of claims: the agent gets USDC, the passive agent keeps the claims, at face (Commodity µSIU, as the holdings value them) until they lapse.
        // D151: a bought claim among them closes unused instead (the passive agent never bought it and keeps the money)
        if (e.forced === "sweep" && isAgent(e.from)) {
          move(e.from, "usdc", big(e.usdc), false);
          const t = holding ? takeLots(e.from, tokenId, milli) : [];
          closeLots(e.from, t);
          const kept = milli - taken(t);
          if (e.microSiu === undefined) adjustClaims(e.from, undefined, 0n, `forced sale of ${tokenId}`);
          else if (kept > 0n) adjustClaims(e.from, e.forWindow, milli === 0n ? 0n : (big(e.microSiu) * kept) / milli, `forced sale of ${tokenId}`);
        }
        break;
      }
      case "claim-serve":
        // D151: a bought claim the agent's work was served on, and passed, is used: the passive agent buys it now. A failed attempt uses nothing (the claim stays)
        if (holding && e.passed === true && isAgent(e.holder)) useLots(e.holder, takeLots(e.holder, String(e.tokenId), big(e.milli)), `use of ${String(e.tokenId)}`);
        break;
      case "wallet-transfer": {
        const asset = assetOf(e);
        if (!isAgent(e.actor) || asset === undefined) break;
        const amount = big(e[asset]);
        move(e.actor, asset, -amount, false);
        pay(e.actor, asset, amount, `transfer to ${String(e.to)}`);
        if (isAgent(e.to)) move(e.to, asset, amount, true);
        break;
      }
      case "claim-close": {
        if (!isAgent(e.holder)) break;
        // D151: a bought claim that lapses or defaults unused closes unused: the passive agent kept the money, so a default's payout on it is the agent's alone
        const milli = big(e.milli);
        const t = holding ? takeLots(e.holder, String(e.tokenId), milli) : [];
        closeLots(e.holder, t);
        const usdc = big(e.usdc);
        if (usdc > 0n) {
          move(e.holder, "usdc", usdc, false);
          const shared = milli === 0n ? 0n : (usdc * (milli - taken(t))) / milli;
          (passive.get(e.holder) as Passive).usdc += shared;
        }
        break;
      }
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
        pay(e.actor, asset, big(e[asset]), "data purchase");
        break;
      }
      default:
        break;
    }
  }
  return { closes, mismatches, conversions, claimHolds, shortfalls };
}
