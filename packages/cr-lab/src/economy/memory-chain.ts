/**
 * The CR economy's contracts, modelled in memory (WP3's memory ledger, `docs/part5-build-plan.md` §3.2): `CapacityBond`, `WorkClaim`, the eligibility router, `TouchstoneEscrow`
 * (one over test USDC, one over AGU-lab), `AguBuffer` and `AguLab`, with the same rules and the same integer rounding as the Solidity, so scripted windows run free and fast and one
 * scripted window can be replayed on `anvil` and compared to the base unit (§6, "memory against anvil").
 *
 * Every rule that a contract enforces with a revert throws here with the rule in its message. Nothing here decides anything an agent should decide: it only refuses what the
 * contracts refuse and moves what they move.
 *
 * Accounts are plain strings (an agent id, `reserve`, `buffer`, `income`, `participant`, an issuer id, `bond`, an escrow id). Two balances per account: test USDC and AGU-lab.
 */
import { createHash } from "node:crypto";
import {
  AGU_PER_MILLI_SIU_AT_START,
  BPS,
  discounted,
  usdcFor,
  type AguUnits,
  type MilliSiu,
  type NanoUsdPerSiu,
  type UsdcUnits,
} from "./units.js";

export type Asset = "USDC" | "AGU";
export type Series = "frontier" | "commodity";
export type Account = string;

/**
 * v2 fix 1 (owner, 2026-11-07): `detail` carries the concrete numbers behind a refusal, where the caller has them, so `World.act`'s catch-all can put an actionable figure on
 * the agent's next board instead of a bare rule name. Optional and additive: every existing `refuse(rule)` call (no detail) is unaffected.
 */
export class ChainRule extends Error {
  constructor(
    rule: string,
    readonly detail?: Readonly<Record<string, bigint | number | string>>,
  ) {
    super(rule);
    this.name = "ChainRule";
  }
}
const refuse = (rule: string, detail?: Readonly<Record<string, bigint | number | string>>): never => {
  throw new ChainRule(rule, detail);
};

export interface ClaimType {
  tokenId: string;
  issuer: Account;
  classId: string;
  series: Series;
  /** unix seconds; the window is [from, to) */
  windowFrom: number;
  windowTo: number;
  referenceRate: NanoUsdPerSiu;
}

interface BondLot {
  committedCapacityHours: bigint;
  measuredRateMilliSiuPerHour: bigint;
  bondedUsdc: UsdcUnits;
  outstanding: MilliSiu;
}

interface Escrow {
  asset: Asset;
  buyer: Account;
  seller: Account;
  settler: Account;
  maxAmount: bigint;
  expiry: number;
  status: "open" | "settled" | "expired";
}

/** `CapacityBond.ISSUANCE_RATIO_BPS` */
export const ISSUANCE_RATIO_BPS = 5_000n;
/** `TouchstoneEscrow.MIN_SETTLEMENT`: a non-zero settlement below it reverts */
export const MIN_SETTLEMENT = 100n;
/** `WorkClaim.SETTLEMENT_RATE_BAND_BPS` */
export const SETTLEMENT_RATE_BAND_BPS = 5_000n;

export interface AguParams {
  /** the grade the reserve may hold (R3, single grade) */
  reserveSeries: Series;
  /** seconds of window a lot must still have to be accepted by `create` or bought by the roll */
  minTenorSeconds: number;
  /** the roll's discount on front-claim sales, basis points */
  discountBps: bigint;
  /** the buffer's target, test USDC base units */
  bufferTarget: UsdcUnits;
}

export interface Sale {
  buyer: Account;
  tokenId: string;
  milli: MilliSiu;
}
export interface Buy {
  classId: string;
  milli: MilliSiu;
}
export interface RollResult {
  proceeds: UsdcUnits;
  cost: UsdcUnits;
  cover: UsdcUnits;
  carryToBuffer: UsdcUnits;
  carryToIncome: UsdcUnits;
  dustToBuffer: UsdcUnits;
  faceSold: MilliSiu;
  faceUnsold: MilliSiu;
  faceBought: MilliSiu;
  minted: { tokenId: string; issuer: Account; classId: string; milli: MilliSiu }[];
}
export interface Redemption {
  units: AguUnits;
  lots: { tokenId: string; milli: MilliSiu; windowTo: number }[];
}

/** one successful call that changed state, in order, as the chain would see it: the journal a window is replayed from onto the contracts */
export interface JournalEntry {
  op: Mutating;
  args: unknown[];
  now: number;
}
export const MUTATING = [
  "mintTestUsdc",
  "transfer",
  "createLot",
  "transferClaim",
  "mint",
  "present",
  "serve",
  "settleWindowClose",
  "escrowOpen",
  "escrowSettle",
  "escrowExpire",
  "create",
  "redeem",
  "seedBuffer",
  "roll",
  "setSkipped",
  "setProbe",
] as const;
export type Mutating = (typeof MUTATING)[number];

interface Saved {
  usdc: Map<Account, UsdcUnits>;
  agu: Map<Account, AguUnits>;
  claims: Map<string, Map<Account, MilliSiu>>;
  claimTypes: Map<string, ClaimType>;
  everPresented: Set<string>;
  settledPositions: Set<string>;
  bondLots: Map<string, BondLot>;
  issuersForClass: Map<string, Account[]>;
  skipped: Set<Account>;
  probeOpen: Set<Account>;
  escrows: Map<string, Escrow>;
  reserveLots: string[];
  retired: Set<string>;
  aguSupply: bigint;
  inRoll: boolean;
}

export const RESERVE = "reserve";
export const BUFFER = "buffer";
export const INCOME = "income";
export const PARTICIPANT = "participant";
export const BOND = "bond";

export class MemoryChain {
  readonly usdc = new Map<Account, UsdcUnits>();
  readonly agu = new Map<Account, AguUnits>();
  readonly claims = new Map<string, Map<Account, MilliSiu>>();
  readonly claimTypes = new Map<string, ClaimType>();
  readonly everPresented = new Set<string>();
  readonly settledPositions = new Set<string>();
  readonly bondLots = new Map<string, BondLot>();
  /** registration order per class, as `CapacityBond.issuersForClass` keeps it (append-only) */
  readonly issuersForClass = new Map<string, Account[]>();
  readonly skipped = new Set<Account>();
  readonly probeOpen = new Set<Account>();
  readonly escrows = new Map<string, Escrow>();
  /** AguLab's lots, in the order first received, and the ones the roll has retired */
  readonly reserveLots: string[] = [];
  readonly retired = new Set<string>();
  aguSupply = 0n;
  #inRoll = false;
  readonly journal: JournalEntry[] = [];
  #depth = 0;

  /**
   * Every state-changing call is ATOMIC, as a contract call is: on a refusal nothing it did stays (a contract reverts the whole call; found 2026-11-04: a mint the buyer could not
   * pay for had already consumed headroom and delivered the claim). Only the outermost call snapshots and is journalled; calls it makes on itself are part of it.
   */
  constructor(
    readonly agu_: AguParams,
    readonly issuerRole: Account,
    readonly now: () => number,
  ) {
    const self = this as unknown as Record<Mutating, (...a: unknown[]) => unknown>;
    for (const name of MUTATING) {
      const orig = self[name].bind(this);
      self[name] = (...args: unknown[]): unknown => this.#atomic(name, args, () => orig(...args));
    }
  }

  #atomic<T>(op: Mutating, args: unknown[], fn: () => T): T {
    if (this.#depth > 0) return fn();
    const saved = this.#save();
    this.#depth++;
    try {
      const out = fn();
      this.journal.push({ op, args: structuredClone(args), now: this.now() });
      return out;
    } catch (e) {
      this.#restore(saved);
      throw e;
    } finally {
      this.#depth--;
    }
  }

  #save(): Saved {
    return structuredClone({
      usdc: this.usdc,
      agu: this.agu,
      claims: this.claims,
      claimTypes: this.claimTypes,
      everPresented: this.everPresented,
      settledPositions: this.settledPositions,
      bondLots: this.bondLots,
      issuersForClass: this.issuersForClass,
      skipped: this.skipped,
      probeOpen: this.probeOpen,
      escrows: this.escrows,
      reserveLots: this.reserveLots,
      retired: this.retired,
      aguSupply: this.aguSupply,
      inRoll: this.#inRoll,
    });
  }

  #restore(s: Saved): void {
    const refill = <K, V>(target: Map<K, V>, from: Map<K, V>): void => {
      target.clear();
      for (const [k, v] of from) target.set(k, v);
    };
    const refillSet = <V>(target: Set<V>, from: Set<V>): void => {
      target.clear();
      for (const v of from) target.add(v);
    };
    refill(this.usdc, s.usdc);
    refill(this.agu, s.agu);
    refill(this.claims, s.claims);
    refill(this.claimTypes, s.claimTypes);
    refillSet(this.everPresented, s.everPresented);
    refillSet(this.settledPositions, s.settledPositions);
    refill(this.bondLots, s.bondLots);
    refill(this.issuersForClass, s.issuersForClass);
    refillSet(this.skipped, s.skipped);
    refillSet(this.probeOpen, s.probeOpen);
    refill(this.escrows, s.escrows);
    this.reserveLots.splice(0, this.reserveLots.length, ...s.reserveLots);
    refillSet(this.retired, s.retired);
    this.aguSupply = s.aguSupply;
    this.#inRoll = s.inRoll;
  }

  /** `EligibleClaimRouter.setSkipped` (the lab publisher only) */
  setSkipped(issuer: Account, skipped: boolean): void {
    if (skipped) this.skipped.add(issuer);
    else this.skipped.delete(issuer);
    this.probeOpen.delete(issuer); // any change to the flag closes an open probe, as the router does
  }
  /** `EligibleClaimRouter.setProbe` (the lab publisher only) */
  setProbe(issuer: Account, open: boolean): void {
    if (open && !this.skipped.has(issuer)) refuse(`NotSkipped: ${issuer}`);
    if (open) this.probeOpen.add(issuer);
    else this.probeOpen.delete(issuer);
  }

  // ---- balances ---------------------------------------------------------------------------------------------------------------------------------
  balance(account: Account, asset: Asset): bigint {
    return (asset === "USDC" ? this.usdc : this.agu).get(account) ?? 0n;
  }
  /** test USDC minted out of nothing: only the setup does this (the labelled test token), never the economy */
  mintTestUsdc(to: Account, amount: UsdcUnits): void {
    this.#add("USDC", to, amount);
  }
  transfer(asset: Asset, from: Account, to: Account, amount: bigint): void {
    if (amount < 0n) refuse("negative transfer");
    if (from === RESERVE && asset === "USDC" && !this.#inRoll)
      refuse("R5: the reserve holds no USDC outside the roll step");
    if (from === BUFFER && !this.#inRoll)
      refuse("the buffer pays only roll cover, inside the roll");
    if (from === INCOME) refuse("the income ledger only ever receives");
    this.#sub(asset, from, amount);
    this.#add(asset, to, amount);
  }
  #add(asset: Asset, a: Account, n: bigint): void {
    const m = asset === "USDC" ? this.usdc : this.agu;
    m.set(a, (m.get(a) ?? 0n) + n);
  }
  #sub(asset: Asset, a: Account, n: bigint): void {
    const have = this.balance(a, asset);
    if (have < n) refuse(`${a} has ${have} ${asset} base units, needs ${n}`);
    (asset === "USDC" ? this.usdc : this.agu).set(a, have - n);
  }

  // ---- CapacityBond + routing --------------------------------------------------------------------------------------------------------------------
  createLot(
    issuer: Account,
    classId: string,
    hours: bigint,
    rateMilliPerHour: bigint,
    bondedUsdc: UsdcUnits,
  ): void {
    const key = `${issuer}|${classId}`;
    if (this.bondLots.has(key)) refuse("LotExists");
    if (hours === 0n || rateMilliPerHour === 0n || bondedUsdc === 0n) refuse("ZeroAmount");
    this.#sub("USDC", issuer, bondedUsdc);
    this.#add("USDC", BOND, bondedUsdc);
    this.bondLots.set(key, {
      committedCapacityHours: hours,
      measuredRateMilliSiuPerHour: rateMilliPerHour,
      bondedUsdc,
      outstanding: 0n,
    });
    const list = this.issuersForClass.get(classId) ?? [];
    list.push(issuer);
    this.issuersForClass.set(classId, list);
  }
  headroom(issuer: Account, classId: string): MilliSiu {
    const lot = this.bondLots.get(`${issuer}|${classId}`);
    if (lot === undefined) return 0n;
    const limit =
      (lot.committedCapacityHours * lot.measuredRateMilliSiuPerHour * ISSUANCE_RATIO_BPS) / BPS;
    return limit > lot.outstanding ? limit - lot.outstanding : 0n;
  }
  /** `EligibleClaimRouter.route`: an open probe first, then first-fit in registration order among issuers not skipped */
  route(classId: string, milli: MilliSiu): Account {
    const candidates = this.issuersForClass.get(classId) ?? [];
    for (const i of candidates)
      if (this.probeOpen.has(i) && this.headroom(i, classId) >= milli) return i;
    for (const i of candidates)
      if (!this.skipped.has(i) && this.headroom(i, classId) >= milli) return i;
    return refuse(`NoIssuerWithHeadroom(${classId}, ${milli})`);
  }

  // ---- WorkClaim -------------------------------------------------------------------------------------------------------------------------------
  static tokenIdFor(
    issuer: Account,
    classId: string,
    series: Series,
    from: number,
    to: number,
  ): string {
    return createHash("sha256")
      .update(JSON.stringify([issuer, classId, series, from, to]))
      .digest("hex")
      .slice(0, 16);
  }
  claimBalance(holder: Account, tokenId: string): MilliSiu {
    return this.claims.get(tokenId)?.get(holder) ?? 0n;
  }
  #moveClaim(
    tokenId: string,
    from: Account | undefined,
    to: Account | undefined,
    milli: MilliSiu,
  ): void {
    const m = this.claims.get(tokenId) ?? new Map<Account, MilliSiu>();
    if (from !== undefined) {
      const have = m.get(from) ?? 0n;
      if (have < milli) refuse(`${from} holds ${have} mSIU of ${tokenId}, needs ${milli}`);
      m.set(from, have - milli);
    }
    if (to !== undefined) m.set(to, (m.get(to) ?? 0n) + milli);
    this.claims.set(tokenId, m);
  }
  transferClaim(tokenId: string, from: Account, to: Account, milli: MilliSiu): void {
    if (from === RESERVE)
      refuse("the reserve's claims move only through create, redeem and the roll");
    this.#moveClaim(tokenId, from, to, milli);
  }
  /** `WorkClaim.mint`: routed, consumes headroom, the buyer pays the issuer at the attested rate */
  mint(
    buyer: Account,
    classId: string,
    series: Series,
    milli: MilliSiu,
    from: number,
    to: number,
    rate: NanoUsdPerSiu,
  ): string {
    if (milli === 0n) refuse("ZeroAmount");
    if (to <= from) refuse("BadWindow");
    if (rate === 0n) refuse("ZeroAmount");
    const issuer = this.route(classId, milli);
    const tokenId = MemoryChain.tokenIdFor(issuer, classId, series, from, to);
    if (!this.claimTypes.has(tokenId))
      this.claimTypes.set(tokenId, {
        tokenId,
        issuer,
        classId,
        series,
        windowFrom: from,
        windowTo: to,
        referenceRate: rate,
      });
    const lot = this.bondLots.get(`${issuer}|${classId}`) as BondLot;
    lot.outstanding += milli;
    this.#moveClaim(tokenId, undefined, buyer, milli);
    const pay = usdcFor(milli, rate);
    this.#sub("USDC", buyer, pay);
    this.#add("USDC", issuer, pay);
    return tokenId;
  }
  present(holder: Account, tokenId: string): void {
    const ct = this.#type(tokenId);
    const t = this.now();
    if (t < ct.windowFrom) refuse("WindowNotOpenYet");
    if (t >= ct.windowTo) refuse("WindowClosed");
    if (this.claimBalance(holder, tokenId) === 0n) refuse("NothingToPresent");
    if (holder === RESERVE) refuse("the reserve never presents a claim");
    this.everPresented.add(`${tokenId}|${holder}`);
  }
  serve(issuer: Account, tokenId: string, holder: Account, milli: MilliSiu, passed: boolean): void {
    const ct = this.#type(tokenId);
    if (issuer !== ct.issuer) refuse("NotTheRoutedIssuer");
    if (this.now() >= ct.windowTo) refuse("WindowClosed");
    if (milli === 0n) refuse("ZeroAmount");
    if (milli > this.claimBalance(holder, tokenId)) refuse("InsufficientRedemption");
    if (passed) {
      this.#moveClaim(tokenId, holder, undefined, milli);
      (this.bondLots.get(`${ct.issuer}|${ct.classId}`) as BondLot).outstanding -= milli;
    }
  }
  /** `WorkClaim.settleWindowClose`: Defaulted (bond pays the holder at the clamped rate) if ever presented, else Expired */
  settleWindowClose(
    tokenId: string,
    holder: Account,
    rate: NanoUsdPerSiu,
  ): { kind: "defaulted" | "expired"; milli: MilliSiu; usdc: UsdcUnits } {
    const ct = this.#type(tokenId);
    if (this.now() < ct.windowTo) refuse("WindowNotClosedYet");
    const key = `${tokenId}|${holder}`;
    if (this.settledPositions.has(key)) refuse("AlreadySettled");
    const milli = this.claimBalance(holder, tokenId);
    if (milli === 0n) refuse("NothingToSettle");
    this.settledPositions.add(key);
    this.#moveClaim(tokenId, holder, undefined, milli);
    const lot = this.bondLots.get(`${ct.issuer}|${ct.classId}`) as BondLot;
    lot.outstanding -= milli;
    if (!this.everPresented.has(key)) return { kind: "expired", milli, usdc: 0n };
    const band = (ct.referenceRate * SETTLEMENT_RATE_BAND_BPS) / BPS;
    const clamped =
      rate > ct.referenceRate + band
        ? ct.referenceRate + band
        : rate < ct.referenceRate - band
          ? ct.referenceRate - band
          : rate;
    const amount = usdcFor(milli, clamped);
    if (amount > lot.bondedUsdc) refuse("InsufficientBond");
    lot.bondedUsdc -= amount;
    this.#sub("USDC", BOND, amount);
    this.#add("USDC", holder, amount);
    return { kind: "defaulted", milli, usdc: amount };
  }
  #type(tokenId: string): ClaimType {
    return this.claimTypes.get(tokenId) ?? refuse("NothingToPresent");
  }

  // ---- TouchstoneEscrow (one per asset, fee zero) ----------------------------------------------------------------------------------------------
  escrowOpen(
    id: string,
    asset: Asset,
    buyer: Account,
    seller: Account,
    settler: Account,
    maxAmount: bigint,
    expiry: number,
  ): void {
    if (this.escrows.has(id)) refuse("EscrowExists");
    if (maxAmount === 0n) refuse("ZeroAmount");
    if (expiry <= this.now()) refuse("ExpiryNotInFuture");
    this.#sub(asset, buyer, maxAmount);
    this.#add(asset, `escrow:${id}`, maxAmount);
    this.escrows.set(id, { asset, buyer, seller, settler, maxAmount, expiry, status: "open" });
  }
  /** settle `actual` (0 is a full refund); only the recorded settler; a non-zero amount below MIN_SETTLEMENT reverts */
  escrowSettle(id: string, caller: Account, actual: bigint): void {
    const e = this.escrows.get(id) ?? refuse("NoEscrow");
    if (e.status !== "open") refuse("NotOpen");
    if (caller !== e.settler) refuse("NotSettler");
    if (this.now() > e.expiry) refuse("PastExpiry");
    if (actual > e.maxAmount) refuse("OverMax");
    if (actual !== 0n && actual < MIN_SETTLEMENT) refuse("BelowMinSettlement", { actual, min: MIN_SETTLEMENT });
    e.status = "settled";
    this.#sub(e.asset, `escrow:${id}`, e.maxAmount);
    this.#add(e.asset, e.seller, actual);
    this.#add(e.asset, e.buyer, e.maxAmount - actual);
  }
  escrowExpire(id: string): void {
    const e = this.escrows.get(id) ?? refuse("NoEscrow");
    if (e.status !== "open") refuse("NotOpen");
    if (this.now() <= e.expiry) refuse("NotExpired");
    e.status = "expired";
    this.#sub(e.asset, `escrow:${id}`, e.maxAmount);
    this.#add(e.asset, e.buyer, e.maxAmount);
  }

  // ---- AguLab -----------------------------------------------------------------------------------------------------------------------------------
  #liveLots(): string[] {
    const t = this.now();
    return this.reserveLots.filter(
      (id) =>
        !this.retired.has(id) &&
        (this.claimTypes.get(id) as ClaimType).windowTo > t &&
        this.claimBalance(RESERVE, id) > 0n,
    );
  }
  liveFace(): MilliSiu {
    return this.#liveLots().reduce((s, id) => s + this.claimBalance(RESERVE, id), 0n);
  }
  /** reserve NAV in SIU per AGU-lab, as an exact fraction: live face (SIU) ÷ supply (AGU-lab) */
  nav(): { num: bigint; den: bigint } {
    // face mSIU / 1000 per (supply / 1e6) = face * 1000 / supply
    return { num: this.liveFace() * 1_000n, den: this.aguSupply };
  }
  create(caller: Account, tokenId: string, milli: MilliSiu): AguUnits {
    if (caller !== PARTICIPANT) refuse("only the authorised participant creates");
    const ct = this.#type(tokenId);
    if (ct.series !== this.agu_.reserveSeries)
      refuse(`R3: the reserve holds ${this.agu_.reserveSeries} claims only, not ${ct.series}`);
    if (this.retired.has(tokenId))
      refuse(`LotRetired: ${tokenId} (creating into it would dilute holders)`);
    if (ct.windowTo - this.now() < this.agu_.minTenorSeconds)
      refuse("R3: too little tenor left on this lot");
    if (milli === 0n) refuse("ZeroAmount");
    const face = this.liveFace();
    const units =
      this.aguSupply === 0n
        ? milli * AGU_PER_MILLI_SIU_AT_START
        : face === 0n
          ? refuse("no live face to price a creation against")
          : (milli * this.aguSupply) / face;
    if (units === 0n) refuse("creation too small to mint a unit");
    this.#moveClaim(tokenId, caller, RESERVE, milli);
    if (!this.reserveLots.includes(tokenId)) this.reserveLots.push(tokenId);
    this.aguSupply += units;
    this.#add("AGU", caller, units);
    return units;
  }
  /** R4: in kind, pro rata over every live lot, rounded down; never USDC, never the buffer */
  redeem(holder: Account, units: AguUnits): Redemption {
    if (units === 0n) refuse("ZeroAmount");
    const supply = this.aguSupply;
    const lots = this.#liveLots().map((id) => ({
      id,
      milli: (units * this.claimBalance(RESERVE, id)) / supply,
    }));
    if (lots.every((l) => l.milli === 0n))
      refuse(`NothingToRedeem(${units}): too few units to deliver any claim`);
    this.#sub("AGU", holder, units);
    this.aguSupply -= units;
    const out: Redemption = { units, lots: [] };
    for (const l of lots) {
      if (l.milli === 0n) continue;
      this.#moveClaim(l.id, RESERVE, holder, l.milli);
      out.lots.push({
        tokenId: l.id,
        milli: l.milli,
        windowTo: (this.claimTypes.get(l.id) as ClaimType).windowTo,
      });
    }
    return out;
  }
  /** `AguBuffer.seed`: anyone may add USDC to the buffer */
  seedBuffer(from: Account, amount: UsdcUnits): void {
    this.transfer("USDC", from, BUFFER, amount);
  }

  /**
   * R5 to R7: one step. Retire the front lots, sell front claims at the discounted print, buy next-window claims to restore the face, cover a shortfall from the buffer first (then
   * buy what is affordable and NAV falls), send carry to the buffer up to its target and the rest to the income ledger, and end with exactly zero reserve USDC.
   */
  roll(
    caller: Account,
    args: {
      rate: NanoUsdPerSiu;
      frontLots: string[];
      sales: Sale[];
      buys: Buy[];
      buyFrom: number;
      buyTo: number;
    },
  ): RollResult {
    // AguLab.roll, step for step (checked against the contract on anvil by the DW1 replay, 2026-11-05)
    if (caller !== this.issuerRole) refuse("NotAguIssuer: only the AGU-lab issuer role rolls");
    this.#inRoll = true;
    try {
      const t = this.now();
      // _retireFront: each lot live and in its window now
      let required = 0n;
      let frontEnd = 0;
      for (const id of args.frontLots) {
        const ct = this.claimTypes.get(id);
        if (!this.reserveLots.includes(id) || this.retired.has(id) || ct === undefined)
          refuse(`NotLiveLot: ${id}`);
        const c = ct as ClaimType;
        if (t < c.windowFrom || t >= c.windowTo) refuse(`NotAFrontLot: ${id}`);
        this.retired.add(id);
        required += this.claimBalance(RESERVE, id);
        if (c.windowTo > frontEnd) frontEnd = c.windowTo;
      }
      // _sellFront: eligible buyers, lots retired by this roll, never a sale that rounds to zero
      const price = discounted(args.rate, this.agu_.discountBps);
      let proceeds = 0n;
      let faceSold = 0n;
      for (const s of args.sales) {
        if ([PARTICIPANT, INCOME, BUFFER, this.issuerRole, RESERVE, ""].includes(s.buyer))
          refuse(`IneligibleBuyer: ${s.buyer}`);
        if (s.milli === 0n) refuse("ZeroAmount");
        if (!args.frontLots.includes(s.tokenId))
          refuse(`NotRetiredThisRoll: R5, the roll sells front lots only (${s.tokenId})`);
        const pay = usdcFor(s.milli, price);
        if (pay === 0n) refuse(`SaleRoundsToZero(${s.milli})`);
        this.#sub("USDC", s.buyer, pay);
        this.#add("USDC", RESERVE, pay);
        this.#moveClaim(s.tokenId, RESERVE, s.buyer, s.milli);
        proceeds += pay;
        faceSold += s.milli;
      }
      const faceUnsold = required - faceSold;
      // _priceBuys
      if (args.buys.length > 0) {
        if (args.buyFrom < frontEnd)
          refuse("BuyWindowOverlapsFront: R5, next-window lots start after the front lots end");
        if (args.buyTo - t < this.agu_.minTenorSeconds)
          refuse("R5: bought lots need the minimum tenor");
      }
      let cost = 0n;
      let bought = 0n;
      for (const b of args.buys) {
        if (b.milli === 0n) refuse("ZeroAmount");
        cost += usdcFor(b.milli, args.rate);
        bought += b.milli;
      }
      if (bought > required)
        refuse(
          `RollOverbuys(${bought}, ${required}): R5, the roll buys no more face than it restores`,
        );
      // _drawCover
      const funds = this.balance(RESERVE, "USDC");
      const bufferBal = this.balance(BUFFER, "USDC");
      let cover = 0n;
      if (bought === required) {
        if (cost > funds) {
          const shortfall = cost - funds;
          if (shortfall > bufferBal)
            refuse(`RollShortfallExceedsBuffer(${shortfall}, ${bufferBal}): R6`);
          cover = shortfall;
        }
      } else {
        const available = funds + bufferBal;
        if (cost > available)
          refuse(
            `RollUnaffordable(${cost}, ${available}): R6, these buys cost more than the proceeds and the whole buffer`,
          );
        const last = args.buys.at(-1);
        const oneMore =
          last === undefined
            ? usdcFor(1n, args.rate)
            : usdcFor(last.milli + 1n, args.rate) - usdcFor(last.milli, args.rate);
        if (available - cost >= oneMore)
          refuse(
            `RollUnderbuys(${bought}, ${required}, ${available - cost}, ${oneMore}): R6, with the buffer exhausted the roll buys the most face it can afford`,
          );
        if (cost > funds) cover = cost - funds;
      }
      if (cover > 0n) this.transfer("USDC", BUFFER, RESERVE, cover);
      // _buyNext
      const minted: RollResult["minted"] = [];
      for (const b of args.buys) {
        const id = this.mint(
          RESERVE,
          b.classId,
          this.agu_.reserveSeries,
          b.milli,
          args.buyFrom,
          args.buyTo,
          args.rate,
        );
        if (this.retired.has(id)) refuse(`LotRetired: ${id}`);
        if (!this.reserveLots.includes(id)) this.reserveLots.push(id);
        minted.push({
          tokenId: id,
          issuer: (this.claimTypes.get(id) as ClaimType).issuer,
          classId: b.classId,
          milli: b.milli,
        });
      }
      // _sendLeftover: carry (full face) tops the buffer up to its target and the rest goes to income; after an underbuy every remainder goes to the buffer
      const left = this.balance(RESERVE, "USDC");
      let carryToBuffer = 0n;
      let carryToIncome = 0n;
      let dustToBuffer = 0n;
      if (left > 0n) {
        if (bought === required) {
          const held = this.balance(BUFFER, "USDC");
          const room = this.agu_.bufferTarget > held ? this.agu_.bufferTarget - held : 0n;
          carryToBuffer = left < room ? left : room;
          carryToIncome = left - carryToBuffer;
          this.transfer("USDC", RESERVE, BUFFER, carryToBuffer);
          this.transfer("USDC", RESERVE, INCOME, carryToIncome);
        } else {
          dustToBuffer = left;
          this.transfer("USDC", RESERVE, BUFFER, left);
        }
      }
      if (this.balance(RESERVE, "USDC") !== 0n)
        refuse("ReserveUsdcNotZero: R5, the roll must end with zero reserve USDC");
      return {
        proceeds,
        cost,
        cover,
        carryToBuffer,
        carryToIncome,
        dustToBuffer,
        faceSold,
        faceUnsold,
        faceBought: bought,
        minted,
      };
    } finally {
      this.#inRoll = false;
    }
  }
}
