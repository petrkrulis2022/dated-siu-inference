/**
 * The CR economy's state and the one place an agent's action is carried out (`docs/part5-build-plan.md` §16.9 of the trial plan, and §3 to §6 of the Part 5 build plan).
 *
 * Who does what:
 *  - Demand agents have a mandate and a need each window (a brief covering two task types). They pay for briefs in AGU-lab, which they buy from the authorised participant with USDC.
 *  - Research agents buy data (USDC, at the data agent's shadow price), commission task work from issuers (AGU-lab, escrowed, paid on a pass), and sell briefs (AGU-lab, escrowed, paid
 *    only if every component passed on the same snapshot hash).
 *  - The hedger sold briefs forward for USDC and covers them with work claims it buys ahead, or with commissioned work.
 *  - Any holder of AGU-lab may redeem it in kind (claims on the reserve's lots) and present those claims for work in their window; any agent may order front claims for the next
 *    window, which the roll sells at the discounted print (the dollar route to work).
 *  - Issuers (code) do the task work through a `TaskWorker`; the AGU-lab issuer (code) runs the roll; the participant (code) quotes and trades.
 *
 * Every price inside the market is quoted in SIU (micro-SIU here, an exact integer) and paid in AGU-lab at the published reserve NAV. The only dollar costs are data, sweeps and the
 * roll's front-claim sales (§4.2, "Dollar flows, stated honestly").
 *
 * An agent's action that the rules refuse is not an error of the economy: it is refused, logged, and told to the agent on its next board. An invariant that fails is an error of
 * the economy and stops the window (§6, stop rules).
 */
import { D, type DecimalValue } from "@touchstone/sdk";
import { TASKS, type TaskId } from "../tasks/instances.js";
import type { EconomyLog } from "./log.js";
import {
  BUFFER,
  ChainRule,
  INCOME,
  MemoryChain,
  PARTICIPANT,
  RESERVE,
  type Series,
} from "./memory-chain.js";
import type { EconomyParams, IssuerParams } from "./params.js";
import { Participant, ParticipantRefused } from "./participant.js";
import {
  show,
  usdcFor,
  type AguUnits,
  type MilliSiu,
  type NanoUsdPerSiu,
  type UsdcUnits,
} from "./units.js";

export type MicroSiu = bigint;
export const DATASET_FOR: Readonly<Record<TaskId, string>> = {
  "CR-VS": "perp",
  "CR-PL": "lending",
  "CR-UO": "tokens",
  "CR-SM": "stablecoins",
};
export const DATA_AGENT = "DATA-AGENT";
export const GATE_RUNNER = "GATE-RUNNER";
export const AGU_ISSUER = "AGU-ISSUER";

export type Role = "research" | "demand" | "hedger";

export type Action =
  | { tool: "pass" }
  | { tool: "message"; to: string; text: string }
  | { tool: "buy_agu"; usdc?: UsdcUnits; agu?: AguUnits }
  | { tool: "sell_agu"; agu: AguUnits }
  | { tool: "redeem_agu"; agu: AguUnits }
  | { tool: "present_claim"; claim: string }
  | { tool: "order_front_claim"; task: TaskId; milli: MilliSiu }
  | { tool: "post_quote"; need: string; tasks: TaskId[]; priceMicroSiu: MicroSiu }
  | { tool: "accept_quote"; quote: string }
  | { tool: "buy_data"; dataset: string }
  | { tool: "commission_task"; tasks: TaskId[]; issuer: string }
  | { tool: "deliver_brief"; quote: string }
  | { tool: "buy_claims"; task: TaskId; milli: MilliSiu; windowsAhead: number }
  | { tool: "deliver_forward" };
export type Tool = Action["tool"];

export interface TaskOutput {
  id: string;
  owner: string;
  task: TaskId;
  passed: boolean;
  dataSha: string;
  issuer: string;
  window: number;
  used: boolean;
}
export interface Need {
  id: string;
  agent: string;
  tasks: TaskId[];
  window: number;
  status: "open" | "met" | "lapsed";
}
export interface Quote {
  id: string;
  researcher: string;
  demand: string;
  need: string;
  tasks: TaskId[];
  priceMicroSiu: MicroSiu;
  status: "posted" | "accepted" | "delivered" | "failed" | "lapsed";
  escrow?: string;
  agu?: AguUnits;
}
export interface FrontOrder {
  agent: string;
  task: TaskId;
  milli: MilliSiu;
  forWindow: number;
}
export interface WorkOutcome {
  passed: boolean;
  costUsd: DecimalValue;
  dataSha: string;
}
export interface TaskWorker {
  work(
    issuer: IssuerParams,
    task: TaskId,
    ctx: { window: number; round: number; key: string },
  ): Promise<WorkOutcome>;
}
export interface ExitRecord {
  agent: string;
  window: number;
  round: number;
  agu: AguUnits;
  usdc: UsdcUnits;
  reasoning: string;
  /** set at window close: dollar cost with the sub-label when a front-claim purchase follows in the same window */
  label?: string;
}
export interface Outcome {
  ok: boolean;
  note: string;
}

export class InvariantFailure extends Error {
  constructor(what: string) {
    super(`economy invariant failed: ${what}`);
    this.name = "InvariantFailure";
  }
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
/** one presentation is one task's work: a quarter of a CR-SIU */
export const TASK_MILLI = 250n;

export class World {
  readonly chain: MemoryChain;
  readonly participant: Participant;
  readonly needs: Need[] = [];
  readonly quotes: Quote[] = [];
  readonly outputs: TaskOutput[] = [];
  readonly frontOrders: FrontOrder[] = [];
  readonly exits: ExitRecord[] = [];
  readonly notices = new Map<string, string[]>();
  readonly lastResult = new Map<string, string>();
  readonly dataBought = new Set<string>();
  readonly delivery = new Map<string, { presented: number; served: number }[]>();
  readonly spentAguThisWindow = new Map<string, AguUnits>();
  readonly frontPurchases: { agent: string; window: number; milli: MilliSiu; usdc: UsdcUnits }[] =
    [];
  readonly warned = new Set<string>();
  /** R11: the probe lots offered to skipped issuers, and how many of each issuer's probes were served */
  readonly probeLots = new Set<string>();
  readonly probesServed = new Map<string, number>();
  readonly roles = new Map<string, Role>();
  forwardDelivered = 0;
  workSpendUsd = new D(0);
  window = 0;
  round = 0;
  #seq = 0;
  #mintedUsdc = 0n;
  #bufferIn = 0n;
  #bufferOut = 0n;
  #incomeIn = 0n;

  constructor(
    readonly params: EconomyParams,
    readonly log: EconomyLog,
    readonly worker: TaskWorker,
    readonly rates: Readonly<Record<Series, NanoUsdPerSiu>>,
    /** each issuer's price per task, micro-SIU, from its measured cost per pass (WP0) */
    readonly taskPrice: Readonly<Record<string, Partial<Record<TaskId, MicroSiu>>>>,
    readonly dataSha: (window: number) => string,
    readonly dayLabel: (window: number) => string,
    readonly t0: number,
    readonly clock: { now: number },
  ) {
    this.chain = new MemoryChain(
      {
        reserveSeries: params.reserve.series,
        minTenorSeconds: params.reserve.minTenorSeconds,
        discountBps: params.reserve.discountBps,
        bufferTarget: params.reserve.bufferTargetUsdc,
      },
      AGU_ISSUER,
      () => clock.now,
    );
    this.participant = new Participant(
      this.chain,
      params.participant.spreadBps,
      params.participant.buybackCapBps,
    );
    for (const a of params.agents.research) this.roles.set(a, "research");
    for (const a of params.agents.demand) this.roles.set(a, "demand");
    this.roles.set(params.agents.hedger, "hedger");
  }

  // ---- time --------------------------------------------------------------------------------------------------------------------------------------
  windowFrom(k: number): number {
    return this.t0 + k * this.params.secondsPerWindow;
  }
  windowTo(k: number): number {
    return this.windowFrom(k + 1);
  }
  setTime(k: number, round: number): void {
    this.window = k;
    this.round = round;
    const step = Math.floor(this.params.secondsPerWindow / (this.params.roundsPerWindow + 3));
    this.clock.now = this.windowFrom(k) + (round + 1) * step;
  }
  #id(prefix: string): string {
    return `${prefix}-${++this.#seq}`;
  }
  #log(
    actor: string,
    kind: Parameters<EconomyLog["write"]>[3],
    fields: Record<string, unknown> = {},
  ): void {
    this.log.write(this.dayLabel(this.window), this.round, actor, kind, fields);
  }
  notify(agent: string, text: string): void {
    const list = this.notices.get(agent) ?? [];
    list.push(text);
    this.notices.set(agent, list);
    this.#log(agent, "notice", { text });
  }
  mint(to: string, usdc: UsdcUnits): void {
    this.chain.mintTestUsdc(to, usdc);
    this.#mintedUsdc += usdc;
  }

  // ---- valuation -----------------------------------------------------------------------------------------------------------------------------------
  get commodityRate(): NanoUsdPerSiu {
    return this.rates.commodity;
  }
  /** AGU-lab base units that pay `price` micro-SIU at the reserve NAV, rounded up so the payment covers the quote */
  aguFor(price: MicroSiu): AguUnits {
    const { num, den } = this.chain.nav();
    if (num === 0n) throw new ChainRule("no NAV: the reserve is empty");
    return ceilDiv(price * den, num);
  }
  /** micro-SIU of reserve value behind `units` (rounded down) */
  siuOf(units: AguUnits): MicroSiu {
    const { num, den } = this.chain.nav();
    return den === 0n ? 0n : (units * num) / den;
  }
  navText(): string {
    const { num, den } = this.chain.nav();
    return den === 0n ? "none" : new D(String(num)).div(String(den)).toFixed(6);
  }

  // ---- the agents' actions --------------------------------------------------------------------------------------------------------------------------
  async act(agent: string, action: Action, reasoning: string): Promise<Outcome> {
    const role = this.roles.get(agent);
    if (role === undefined)
      return this.#result(agent, { ok: false, note: `unknown agent ${agent}` });
    try {
      const r = await this.#act(agent, role, action, reasoning);
      return this.#result(agent, r);
    } catch (e) {
      if (e instanceof ChainRule || e instanceof ParticipantRefused) {
        this.#log(agent, "error", { tool: action.tool, refused: e.message });
        return this.#result(agent, { ok: false, note: `refused: ${e.message}` });
      }
      throw e;
    }
  }
  #result(agent: string, r: Outcome): Outcome {
    this.lastResult.set(agent, `${r.ok ? "done" : "not done"}: ${r.note}`);
    return r;
  }

  async #act(agent: string, role: Role, a: Action, reasoning: string): Promise<Outcome> {
    switch (a.tool) {
      case "pass":
        return { ok: true, note: "you passed this round" };
      case "message": {
        if (a.to !== "all" && !this.roles.has(a.to))
          return {
            ok: false,
            note: `no agent ${a.to}; the agents are listed on your board, or send to "all"`,
          };
        this.#log(agent, "message", { to: a.to, text: a.text });
        const to = a.to === "all" ? [...this.roles.keys()].filter((x) => x !== agent) : [a.to];
        for (const x of to)
          this.notify(x, `message from ${agent}${a.to === "all" ? " to all" : ""}: ${a.text}`);
        return { ok: true, note: `message sent to ${a.to}` };
      }
      case "buy_agu":
        return this.#buyAgu(agent, a);
      case "sell_agu":
        return this.#sellAgu(agent, a.agu, reasoning);
      case "redeem_agu":
        return this.#redeem(agent, a.agu);
      case "present_claim":
        return this.#present(agent, a.claim);
      case "order_front_claim": {
        if (a.milli <= 0n) return { ok: false, note: "order at least 0.001 SIU" };
        this.frontOrders.push({ agent, task: a.task, milli: a.milli, forWindow: this.window + 1 });
        this.#log(agent, "message", {
          to: AGU_ISSUER,
          text: `front-claim order: ${show(a.milli, 3)} SIU of ${a.task} for the next window`,
        });
        return {
          ok: true,
          note: `ordered ${show(a.milli, 3)} SIU of ${a.task} claims for the next window, paid in USDC at the roll`,
        };
      }
      case "post_quote":
        return this.#postQuote(agent, role, a);
      case "accept_quote":
        return this.#acceptQuote(agent, role, a.quote);
      case "buy_data":
        return this.#buyData(agent, a.dataset);
      case "commission_task": {
        if (a.tasks.length < 1 || a.tasks.length > 4 || new Set(a.tasks).size !== a.tasks.length)
          return { ok: false, note: "commission 1 to 4 different task types at once" };
        const notes: string[] = [];
        let anyOk = false;
        for (const t of a.tasks) {
          const r = await this.#commission(agent, t, a.issuer);
          anyOk ||= r.ok;
          notes.push(`${t}: ${r.note}`);
        }
        return { ok: anyOk, note: notes.join("; ") };
      }
      case "deliver_brief":
        return this.#deliverBrief(agent, role, a.quote);
      case "buy_claims":
        return this.#buyClaims(agent, a.task, a.milli, a.windowsAhead);
      case "deliver_forward":
        return this.#deliverForward(agent, role);
    }
  }

  /** buy an exact amount of AGU-lab (`agu`, the ask charged for exactly that) or as much as a USDC amount buys at the ask (`usdc`) */
  #buyAgu(agent: string, a: { usdc?: UsdcUnits; agu?: AguUnits }): Outcome {
    const m = this.params.mandates[agent];
    const rate = this.commodityRate;
    const units = a.agu ?? (a.usdc !== undefined ? this.participant.unitsFor(a.usdc, rate) : 0n);
    if (units === 0n) return { ok: false, note: "that buys no AGU-lab at the ask" };
    if (m !== undefined) {
      const ceiling = this.holdingCeilingMicroSiu(agent);
      if (this.siuOf(this.chain.balance(agent, "AGU") + units) > ceiling)
        return { ok: false, note: `mandate: holding ceiling of ${show(ceiling)} SIU in AGU-lab` };
      if (
        this.chain.balance(agent, "USDC") - this.participant.quote(units, rate).ask <
        m.minUsdcBuffer
      )
        return { ok: false, note: `mandate: keep at least ${show(m.minUsdcBuffer)} USDC` };
    }
    const short = units - this.chain.balance(PARTICIPANT, "AGU");
    if (short > 0n) this.#participantTopUp(short);
    const have = this.chain.balance(PARTICIPANT, "AGU");
    if (have === 0n)
      return {
        ok: false,
        note: "the participant has no AGU-lab to sell and the issuers have no capacity left this window",
      };
    const fill = units < have ? units : have;
    const r = this.participant.sell(agent, fill, rate);
    this.#log(PARTICIPANT, "participant-sell", {
      to: agent,
      agu: r.units,
      usdc: r.usdc,
      asked: units,
    });
    return fill < units
      ? {
          ok: true,
          note: `partly filled: bought ${show(r.units)} of the ${show(units)} AGU-lab asked, for ${show(r.usdc)} USDC; the issuers have no more capacity this window`,
        }
      : { ok: true, note: `bought ${show(r.units)} AGU-lab for ${show(r.usdc)} USDC` };
  }

  /**
   * The authorised participant creates AGU-lab on demand (§4.2): when its inventory is short of a sale, it buys claims from the reserve's grade's issuers with its own USDC, for the
   * far end of the ladder, and creates at NAV. If its USDC or the issuers' headroom runs out it creates what it can, and the sale then refuses as before; it never draws on the reserve
   * or the buffer (found in DW2, 2026-11-05: its genesis inventory of 12 AGU-lab ran out in the first round).
   */
  #participantTopUp(unitsShort: AguUnits): void {
    const k = this.window + this.params.ladderWindows;
    const classes = this.#reserveClasses();
    const supply = this.chain.aguSupply;
    const face = this.chain.liveFace();
    // face needed so that floor(face × supply ÷ liveFace) covers the shortfall, plus one mSIU per class for rounding
    let need =
      supply === 0n || face === 0n
        ? unitsShort / 1_000n + 1n
        : (unitsShort * face + supply - 1n) / supply + BigInt(classes.length);
    // on-demand creation leaves one window's ladder per class of capacity for the ladder and the roll
    const keep = this.params.reserve.faceMilliPerWindow / BigInt(classes.length);
    for (let i = 0; i < classes.length && need > 0n; i++) {
      const share = (need + BigInt(classes.length - i) - 1n) / BigInt(classes.length - i);
      need -= this.#createWithin(classes[i] as string, share, k, true, keep);
    }
  }

  /**
   * Has the participant buy up to `milli` of `classId` claims for window `k` and create AGU-lab with them, issuer by issuer within each eligible issuer's remaining capacity
   * (a mint is routed to one issuer), never using the last `keep` mSIU of capacity in the class. Capacity is one pool per issuer and class across every window, restored only when
   * claims are redeemed, default or expire. Returns the face created.
   */
  #createWithin(
    classId: string,
    milli: MilliSiu,
    k: number,
    onDemand: boolean,
    keep: MilliSiu,
  ): MilliSiu {
    let made = 0n;
    while (made < milli) {
      const room = this.#largestHeadroom(classId) - keep;
      if (room <= 0n) break;
      const want = milli - made;
      const m = want < room ? want : room;
      try {
        const id = this.chain.mint(
          PARTICIPANT,
          classId,
          this.params.reserve.series,
          m,
          this.windowFrom(k),
          this.windowTo(k),
          this.commodityRate,
        );
        const units = this.chain.create(PARTICIPANT, id, m);
        this.#log(PARTICIPANT, "create", {
          tokenId: id,
          task: classId,
          milli: m,
          forWindow: k,
          agu: units,
          ...(onDemand ? { onDemand: true } : {}),
        });
        made += m;
      } catch (e) {
        if (!(e instanceof ChainRule)) throw e;
        this.#log(PARTICIPANT, "error", { create: classId, refused: e.message });
        break;
      }
    }
    return made;
  }

  #reserveClasses(): string[] {
    return [
      ...new Set(
        this.params.issuers
          .filter((i) => i.grade === this.params.reserve.series)
          .flatMap((i) => i.classes),
      ),
    ];
  }

  /** the most one eligible issuer of the reserve's grade can still issue in `classId` */
  #largestHeadroom(classId: string): MilliSiu {
    let best = 0n;
    for (const i of this.chain.issuersForClass.get(classId) ?? []) {
      if (this.chain.skipped.has(i)) continue;
      const h = this.chain.headroom(i, classId);
      if (h > best) best = h;
    }
    return best;
  }

  /** what the participant can sell right now: its inventory plus what it could still create from the issuers' remaining headroom, at reserve NAV */
  participantCanSell(): AguUnits {
    const inventory = this.chain.balance(PARTICIPANT, "AGU");
    const supply = this.chain.aguSupply;
    const face = this.chain.liveFace();
    if (supply === 0n || face === 0n) return inventory;
    let room = 0n;
    for (const c of this.#reserveClasses())
      for (const i of this.chain.issuersForClass.get(c) ?? [])
        if (!this.chain.skipped.has(i)) room += this.chain.headroom(i, c);
    const usdcRoom = this.chain.balance(PARTICIPANT, "USDC");
    const affordable = (usdcRoom * 1_000_000n) / this.commodityRate;
    const creatable = room < affordable ? room : affordable;
    return inventory + (creatable * supply) / face;
  }

  /** a demand agent's holding ceiling: its days of upcoming work, valued at the reference brief price */
  holdingCeilingMicroSiu(agent: string): MicroSiu {
    const m = this.params.mandates[agent];
    if (m === undefined) return 0n;
    return (
      BigInt(m.holdingCeilingDays * this.params.needsPerDemandAgentPerWindow) *
      this.referenceBriefMicroSiu()
    );
  }
  referenceBriefMicroSiu(): MicroSiu {
    const prices = Object.values(this.taskPrice).flatMap((p) => Object.values(p));
    const max = prices.reduce((a, b) => (b > a ? b : a), 0n);
    return (2n * max * this.params.briefMarkupBps) / 10_000n;
  }

  #sellAgu(agent: string, units: AguUnits, reasoning: string): Outcome {
    const r = this.participant.buyBack(agent, units, this.commodityRate);
    this.#log(PARTICIPANT, "participant-buyback", { from: agent, agu: r.units, usdc: r.usdc });
    this.#log(agent, "exit", { agu: r.units, usdc: r.usdc });
    this.exits.push({
      agent,
      window: this.window,
      round: this.round,
      agu: r.units,
      usdc: r.usdc,
      reasoning,
    });
    return { ok: true, note: `sold ${show(r.units)} AGU-lab for ${show(r.usdc)} USDC` };
  }

  #redeem(agent: string, units: AguUnits): Outcome {
    const r = this.chain.redeem(agent, units);
    this.#log(agent, "redeem", { agu: units, lots: r.lots });
    for (const l of r.lots) {
      const ct = this.chain.claimTypes.get(l.tokenId);
      // R12: every claim received in kind gets the same arrival notice with its deadline as a bought claim
      this.notify(
        agent,
        `arrival: ${show(l.milli, 3)} SIU of ${ct?.classId} work claim ${l.tokenId}, presentable from window ${this.#windowOf(ct?.windowFrom ?? 0)} until its end; it lapses worthless if never presented`,
      );
    }
    return {
      ok: true,
      note: `redeemed ${show(units)} AGU-lab for ${r.lots.length} claim lot(s) in kind`,
    };
  }
  #windowOf(t: number): number {
    return Math.floor((t - this.t0) / this.params.secondsPerWindow);
  }

  async #present(agent: string, tokenId: string): Promise<Outcome> {
    const ct = this.chain.claimTypes.get(tokenId);
    if (ct === undefined) return { ok: false, note: `no claim ${tokenId}` };
    const milli = this.chain.claimBalance(agent, tokenId);
    // one presentation is one task's work (TASK_MILLI), or what is left of the claim
    const take = milli < TASK_MILLI ? milli : TASK_MILLI;
    if (take === 0n) return { ok: false, note: `you hold none of ${tokenId}` };
    this.chain.present(agent, tokenId);
    this.#log(agent, "claim-present", { tokenId, issuer: ct.issuer, task: ct.classId });
    const issuer = this.#issuer(ct.issuer);
    this.#stat(ct.issuer).presented++;
    const out = await this.worker.work(issuer, ct.classId as TaskId, {
      window: this.window,
      round: this.round,
      key: `${tokenId}:${agent}:${this.#seq}`,
    });
    this.workSpendUsd = this.workSpendUsd.plus(out.costUsd);
    this.#log(GATE_RUNNER, "gate", {
      tokenId,
      issuer: ct.issuer,
      task: ct.classId,
      passed: out.passed,
      dataSha: out.dataSha,
      costUsd: out.costUsd.toFixed(6),
    });
    this.chain.serve(ct.issuer, tokenId, agent, take, out.passed);
    if (out.passed) {
      this.#stat(ct.issuer).served++;
      if (this.probeLots.has(tokenId))
        this.probesServed.set(ct.issuer, (this.probesServed.get(ct.issuer) ?? 0) + 1);
    }
    this.#log(ct.issuer, "claim-serve", {
      tokenId,
      holder: agent,
      milli: take,
      passed: out.passed,
    });
    this.#addOutput(agent, ct.classId as TaskId, out, ct.issuer);
    return {
      ok: true,
      note: `${ct.issuer} did ${ct.classId} work on your claim: ${out.passed ? "PASSED" : "FAILED (the claim stays with you; you may present it again this window)"}`,
    };
  }
  #addOutput(owner: string, task: TaskId, out: WorkOutcome, issuer: string): TaskOutput {
    const o: TaskOutput = {
      id: this.#id("out"),
      owner,
      task,
      passed: out.passed,
      dataSha: out.dataSha,
      issuer,
      window: this.window,
      used: false,
    };
    this.outputs.push(o);
    return o;
  }
  #issuer(id: string): IssuerParams {
    const i = this.params.issuers.find((x) => x.id === id);
    if (i === undefined) throw new ChainRule(`no issuer ${id}`);
    return i;
  }
  #stat(issuer: string): { presented: number; served: number } {
    const list = this.delivery.get(issuer) ?? [];
    this.delivery.set(issuer, list);
    while (list.length <= this.window) list.push({ presented: 0, served: 0 });
    return list[this.window] as { presented: number; served: number };
  }

  #postQuote(agent: string, role: Role, a: Extract<Action, { tool: "post_quote" }>): Outcome {
    if (role !== "research") return { ok: false, note: "only research agents post brief quotes" };
    const need = this.needs.find(
      (n) => n.id === a.need && n.status === "open" && n.window === this.window,
    );
    if (need === undefined) return { ok: false, note: `no open need ${a.need} this window` };
    if (a.tasks.length < 2 || a.tasks.length > 4 || new Set(a.tasks).size !== a.tasks.length)
      return { ok: false, note: "a brief bundles 2 to 4 different task types" };
    if (!need.tasks.every((t) => a.tasks.includes(t)))
      return { ok: false, note: `the quote must cover the need's tasks: ${need.tasks.join(", ")}` };
    if (a.priceMicroSiu <= 0n) return { ok: false, note: "a price must be above zero" };
    const q: Quote = {
      id: this.#id("quote"),
      researcher: agent,
      demand: need.agent,
      need: need.id,
      tasks: a.tasks,
      priceMicroSiu: a.priceMicroSiu,
      status: "posted",
    };
    this.quotes.push(q);
    this.#log(agent, "quote", {
      quote: q.id,
      to: need.agent,
      need: need.id,
      tasks: a.tasks,
      priceSiu: show(a.priceMicroSiu),
    });
    this.notify(
      need.agent,
      `quote ${q.id} from ${agent}: a brief on ${a.tasks.join(" + ")} for ${show(a.priceMicroSiu)} SIU, payable in AGU-lab on delivery of a passing brief`,
    );
    return { ok: true, note: `quote ${q.id} posted to ${need.agent}` };
  }

  #acceptQuote(agent: string, role: Role, id: string): Outcome {
    if (role !== "demand") return { ok: false, note: "only demand agents accept brief quotes" };
    const q = this.quotes.find((x) => x.id === id);
    if (q === undefined || q.demand !== agent || q.status !== "posted")
      return { ok: false, note: `no posted quote ${id} for you` };
    if (this.quotes.some((x) => x.need === q.need && x.status === "accepted"))
      return { ok: false, note: "you already accepted a quote for that need" };
    const units = this.aguFor(q.priceMicroSiu);
    const m = this.params.mandates[agent];
    const spent = this.spentAguThisWindow.get(agent) ?? 0n;
    if (m !== undefined && spent + units > m.spendLimitAguPerWindow)
      return {
        ok: false,
        note: `mandate: spending limit of ${show(m.spendLimitAguPerWindow)} AGU-lab this window`,
      };
    const escrow = this.#id("escrow");
    this.chain.escrowOpen(
      escrow,
      "AGU",
      agent,
      q.researcher,
      GATE_RUNNER,
      units,
      this.windowTo(this.window),
    );
    this.spentAguThisWindow.set(agent, spent + units);
    q.status = "accepted";
    q.escrow = escrow;
    q.agu = units;
    this.#log(agent, "escrow-open", {
      escrow,
      quote: q.id,
      to: q.researcher,
      agu: units,
      priceSiu: show(q.priceMicroSiu),
    });
    this.notify(
      q.researcher,
      `${agent} accepted quote ${q.id}: ${show(units)} AGU-lab is in escrow, released when you deliver a passing brief this window`,
    );
    return { ok: true, note: `accepted ${q.id}: ${show(units)} AGU-lab in escrow` };
  }

  #buyData(agent: string, dataset: string): Outcome {
    if (!Object.values(DATASET_FOR).includes(dataset))
      return { ok: false, note: `no dataset ${dataset}` };
    const key = `${agent}|${this.window}|${dataset}`;
    if (this.dataBought.has(key))
      return { ok: false, note: `you already bought ${dataset} this window` };
    this.chain.transfer("USDC", agent, DATA_AGENT, this.params.dataShadowPriceUsdc);
    this.dataBought.add(key);
    this.#log(agent, "data-purchase", {
      dataset,
      usdc: this.params.dataShadowPriceUsdc,
      dataSha: this.dataSha(this.window),
    });
    return {
      ok: true,
      note: `bought today's ${dataset} data for ${show(this.params.dataShadowPriceUsdc)} USDC`,
    };
  }

  async #commission(agent: string, task: TaskId, issuerId: string): Promise<Outcome> {
    const role = this.roles.get(agent);
    // a research agent works from today's data: the first commission on a dataset buys it (USDC, at the data agent's shadow price)
    if (
      role === "research" &&
      !this.dataBought.has(`${agent}|${this.window}|${DATASET_FOR[task]}`)
    ) {
      const bought = this.#buyData(agent, DATASET_FOR[task]);
      if (!bought.ok) return bought;
    }
    const issuer = this.#issuer(issuerId);
    if (!issuer.classes.includes(task))
      return { ok: false, note: `${issuerId} does not issue ${task}` };
    const price = this.taskPrice[issuerId]?.[task];
    if (price === undefined) return { ok: false, note: `${issuerId} has no price for ${task}` };
    if (this.workSpendUsd.gte(this.params.spendCapUsdPerWindow))
      return { ok: false, note: "the window's work budget is spent" };
    const units = this.aguFor(price);
    const escrow = this.#id("escrow");
    this.chain.escrowOpen(
      escrow,
      "AGU",
      agent,
      issuerId,
      GATE_RUNNER,
      units,
      this.windowTo(this.window),
    );
    this.#log(agent, "escrow-open", {
      escrow,
      to: issuerId,
      task,
      agu: units,
      priceSiu: show(price),
    });
    this.#stat(issuerId).presented++;
    const out = await this.worker.work(issuer, task, {
      window: this.window,
      round: this.round,
      key: `${escrow}`,
    });
    this.workSpendUsd = this.workSpendUsd.plus(out.costUsd);
    this.#log(GATE_RUNNER, "gate", {
      escrow,
      issuer: issuerId,
      task,
      passed: out.passed,
      dataSha: out.dataSha,
      costUsd: out.costUsd.toFixed(6),
    });
    this.chain.escrowSettle(escrow, GATE_RUNNER, out.passed ? units : 0n);
    if (out.passed) this.#stat(issuerId).served++;
    this.#log(GATE_RUNNER, "escrow-settle", {
      escrow,
      paid: out.passed ? units : 0n,
      refunded: out.passed ? 0n : units,
    });
    this.#log(GATE_RUNNER, "receipt", {
      escrow,
      snapshotSha: out.dataSha,
      task,
      verdict: out.passed ? "pass" : "fail",
      agu: out.passed ? units : 0n,
    });
    this.#addOutput(agent, task, out, issuerId);
    return {
      ok: true,
      note: out.passed
        ? `${issuerId} delivered ${task} and passed: paid ${show(units)} AGU-lab`
        : `${issuerId}'s ${task} work failed the gate: your ${show(units)} AGU-lab came back in full`,
    };
  }

  #deliverBrief(agent: string, role: Role, id: string): Outcome {
    if (role !== "research") return { ok: false, note: "only research agents deliver briefs" };
    const q = this.quotes.find((x) => x.id === id);
    if (
      q === undefined ||
      q.researcher !== agent ||
      q.status !== "accepted" ||
      q.escrow === undefined
    )
      return { ok: false, note: `no accepted quote ${id} of yours` };
    const sha = this.dataSha(this.window);
    const parts: TaskOutput[] = [];
    for (const t of q.tasks) {
      const o =
        this.outputs.find(
          (x) =>
            x.owner === agent &&
            x.task === t &&
            !x.used &&
            x.window === this.window &&
            x.passed &&
            x.dataSha === sha,
        ) ??
        this.outputs.find(
          (x) => x.owner === agent && x.task === t && !x.used && x.window === this.window,
        );
      if (o === undefined)
        return { ok: false, note: `you have no ${t} output from today to put in the brief` };
      parts.push(o);
    }
    for (const p of parts) p.used = true;
    const passed = parts.every((p) => p.passed && p.dataSha === sha);
    const paid = passed ? (q.agu as AguUnits) : 0n;
    this.chain.escrowSettle(q.escrow, GATE_RUNNER, paid);
    q.status = passed ? "delivered" : "failed";
    const need = this.needs.find((n) => n.id === q.need);
    if (passed && need !== undefined) need.status = "met";
    this.#log(GATE_RUNNER, "gate", {
      brief: q.id,
      components: parts.map((p) => ({ task: p.task, passed: p.passed, dataSha: p.dataSha })),
      passed,
    });
    this.#log(GATE_RUNNER, "escrow-settle", {
      escrow: q.escrow,
      paid,
      refunded: (q.agu as AguUnits) - paid,
    });
    this.#log(GATE_RUNNER, "receipt", {
      escrow: q.escrow,
      brief: q.id,
      snapshotSha: sha,
      verdict: passed ? "pass" : "fail",
      agu: paid,
    });
    this.notify(
      q.demand,
      `brief ${q.id} from ${agent}: ${passed ? `PASSED, ${show(paid)} AGU-lab paid` : "FAILED, your AGU-lab came back in full; you may commission it again"}`,
    );
    return {
      ok: true,
      note: passed
        ? `brief ${q.id} passed: you were paid ${show(paid)} AGU-lab`
        : `brief ${q.id} failed (a component failed): the buyer was refunded`,
    };
  }

  #buyClaims(agent: string, task: TaskId, milli: MilliSiu, ahead: number): Outcome {
    if (ahead < 1 || ahead > this.params.ladderWindows)
      return { ok: false, note: `buy claims 1 to ${this.params.ladderWindows} windows ahead` };
    const series: Series = this.params.issuers.some(
      (i) => i.grade === "commodity" && i.classes.includes(task),
    )
      ? "commodity"
      : "frontier";
    const k = this.window + ahead;
    const id = this.chain.mint(
      agent,
      task,
      series,
      milli,
      this.windowFrom(k),
      this.windowTo(k),
      this.rates[series],
    );
    this.#log(agent, "claim-mint", {
      tokenId: id,
      task,
      series,
      milli,
      forWindow: k,
      usdc: usdcFor(milli, this.rates[series]),
    });
    this.notify(
      agent,
      `arrival: ${show(milli, 3)} SIU of ${task} work claim ${id}, presentable in window ${k} only; it lapses worthless if never presented`,
    );
    return { ok: true, note: `bought ${show(milli, 3)} SIU of ${task} claims for window ${k}` };
  }

  #deliverForward(agent: string, role: Role): Outcome {
    if (role !== "hedger") return { ok: false, note: "only the hedger owes forward briefs" };
    if (this.forwardDelivered >= this.params.hedger.briefsSold)
      return { ok: false, note: "every forward brief is delivered" };
    const passed = this.outputs.filter(
      (x) => x.owner === agent && !x.used && x.passed && x.window === this.window,
    );
    const distinct = [...new Map(passed.map((p) => [p.task, p])).values()];
    if (distinct.length < 2)
      return {
        ok: false,
        note: "a forward brief needs passing outputs of two task types from today",
      };
    for (const p of distinct.slice(0, 2)) p.used = true;
    this.forwardDelivered++;
    this.#log(GATE_RUNNER, "receipt", {
      forwardBrief: this.forwardDelivered,
      of: this.params.hedger.briefsSold,
      components: distinct.slice(0, 2).map((p) => p.task),
    });
    return {
      ok: true,
      note: `forward brief ${this.forwardDelivered} of ${this.params.hedger.briefsSold} delivered`,
    };
  }

  // ---- the window's own steps -------------------------------------------------------------------------------------------------------------------
  /** genesis: issuers bond lots, the participant builds the reserve ladder, the buffer is seeded, agents are funded */
  genesis(): void {
    const p = this.params;
    for (const i of p.issuers) {
      this.mint(i.id, i.bondUsdc);
      // issuance = deliverability: one window's budget after haircut × measured rate × 0.5 is CapacityBond's own ratio; here one "hour" is one window
      const rate = this.#issuerRateMilliPerWindow(i);
      for (const c of i.classes)
        this.chain.createLot(i.id, c, 1n, rate, i.bondUsdc / BigInt(i.classes.length));
      this.#log(i.id, "setup", { lots: i.classes, rateMilliPerWindow: rate, bondUsdc: i.bondUsdc });
    }
    this.mint(PARTICIPANT, p.participant.usdc);
    this.mint("OWNER", p.reserve.bufferSeedUsdc);
    this.chain.seedBuffer("OWNER", p.reserve.bufferSeedUsdc);
    this.#bufferIn += p.reserve.bufferSeedUsdc;
    this.#log(BUFFER, "buffer", { seed: p.reserve.bufferSeedUsdc });
    for (let k = 1; k <= p.ladderWindows; k++) this.#participantCreates(k);
    for (const a of p.agents.research) this.mint(a, p.researchUsdc);
    for (const a of p.agents.demand) this.mint(a, (p.mandates[a] as { usdc: bigint }).usdc);
    this.mint(p.agents.hedger, p.hedger.usdc);
  }
  /**
   * An issuer's deliverable mSIU per window: its budget divided by the cost of one mSIU of its own work. One task is 250 mSIU (a quarter of a CR-SIU, one of the four types), and a
   * task's cost is its micro-SIU price at the Commodity print. CapacityBond then issues half of it (ISSUANCE_RATIO_BPS); one "hour" of the bond's lot is one window here.
   */
  #issuerRateMilliPerWindow(i: IssuerParams): bigint {
    const prices = Object.values(this.taskPrice[i.id] ?? {});
    if (prices.length === 0) return 0n;
    const avgMicroSiu = prices.reduce((a, b) => a + b, 0n) / BigInt(prices.length);
    const taskUsd = new D(String(avgMicroSiu))
      .div(1e6)
      .times(String(this.rates.commodity))
      .div(1e9);
    if (taskUsd.lte(0)) return 0n;
    const usdPerMilli = taskUsd.div(TASK_MILLI.toString());
    return BigInt(i.budgetUsdPerWindow.div(usdPerMilli).floor().toFixed(0));
  }
  #participantCreates(k: number): void {
    const classes = this.#reserveClasses();
    const each = this.params.reserve.faceMilliPerWindow / BigInt(classes.length);
    // within the issuers' remaining capacity, issuer by issuer; a shortfall is logged, never a crash (found in DW3: on-demand creation had used the capacity up)
    for (const c of classes) {
      const made = this.#createWithin(c, each, k, false, 0n);
      if (made < each)
        this.#log(PARTICIPANT, "error", {
          ladderShort: c,
          forWindow: k,
          wanted: each,
          created: made,
          reason: "the issuers' capacity is used up",
        });
    }
    this.#probeLots(k);
  }

  /**
   * R11's way back: each window, one small probe lot is offered to each skipped issuer of the reserve's grade (one task of its first class, at most `probeShareBps` of the window's
   * face), routed to it by an open probe and bought and created by the participant outside the roll, so the roll itself never buys from a skipped issuer.
   */
  #probeLots(k: number): void {
    const cap = (this.params.reserve.faceMilliPerWindow * this.params.probeShareBps) / 10_000n;
    const milli = TASK_MILLI < cap ? TASK_MILLI : cap;
    if (milli === 0n) return;
    for (const i of this.params.issuers) {
      if (!this.chain.skipped.has(i.id) || i.grade !== this.params.reserve.series) continue;
      const c = i.classes[0];
      if (c === undefined || this.chain.headroom(i.id, c) < milli) continue;
      this.chain.setProbe(i.id, true);
      try {
        const id = this.chain.mint(
          PARTICIPANT,
          c,
          this.params.reserve.series,
          milli,
          this.windowFrom(k),
          this.windowTo(k),
          this.commodityRate,
        );
        this.probeLots.add(id);
        const units = this.chain.create(PARTICIPANT, id, milli);
        this.#log(PARTICIPANT, "create", {
          tokenId: id,
          task: c,
          milli,
          forWindow: k,
          agu: units,
          probeFor: i.id,
        });
      } finally {
        this.chain.setProbe(i.id, false);
      }
    }
  }

  /** the start of window k: participant's cap, the roll, NAV published, needs drawn */
  startWindow(k: number, needsFor: (agent: string, k: number) => TaskId[]): void {
    this.setTime(k, 0);
    this.participant.startWindow();
    this.spentAguThisWindow.clear();
    this.roll(k);
    this.#participantCreates(k + this.params.ladderWindows);
    this.publishNav();
    for (const a of this.params.agents.demand) {
      for (let n = 0; n < this.params.needsPerDemandAgentPerWindow; n++) {
        const need: Need = {
          id: this.#id("need"),
          agent: a,
          tasks: needsFor(a, k),
          window: k,
          status: "open",
        };
        this.needs.push(need);
        this.#log(a, "notice", { need: need.id, tasks: need.tasks });
      }
    }
  }

  /** R5 to R7 for the front window k */
  roll(k: number): void {
    const front = this.chain.reserveLots.filter(
      (id) =>
        !this.chain.retired.has(id) &&
        this.chain.claimTypes.get(id)?.windowFrom === this.windowFrom(k),
    );
    if (front.length === 0) return;
    const rate = this.commodityRate;
    const price = (rate * (10_000n - this.params.reserve.discountBps)) / 10_000n;
    const sales: { buyer: string; tokenId: string; milli: MilliSiu }[] = [];
    const left = new Map(front.map((id) => [id, this.chain.claimBalance(RESERVE, id)]));
    for (const o of this.frontOrders.filter((x) => x.forWindow === k)) {
      const lot = front.find(
        (id) => this.chain.claimTypes.get(id)?.classId === o.task && (left.get(id) ?? 0n) > 0n,
      );
      if (lot === undefined) {
        this.notify(
          o.agent,
          `your front-claim order for ${o.task} was not filled: no ${o.task} front lot left`,
        );
        continue;
      }
      const milli = o.milli < (left.get(lot) ?? 0n) ? o.milli : (left.get(lot) as bigint);
      if (this.chain.balance(o.agent, "USDC") < usdcFor(milli, price)) {
        this.notify(
          o.agent,
          `your front-claim order for ${o.task} was not filled: not enough USDC`,
        );
        continue;
      }
      sales.push({ buyer: o.agent, tokenId: lot, milli });
      left.set(lot, (left.get(lot) as bigint) - milli);
    }
    const faceByClass = new Map<string, MilliSiu>();
    for (const id of front) {
      const c = this.chain.claimTypes.get(id)?.classId as string;
      faceByClass.set(c, (faceByClass.get(c) ?? 0n) + this.chain.claimBalance(RESERVE, id));
    }
    let buys = [...faceByClass].map(([classId, milli]) => ({ classId, milli }));
    const proceeds =
      sales.reduce((n, s) => n + usdcFor(s.milli, price), 0n) + this.chain.balance(RESERVE, "USDC");
    const affordable = proceeds + this.chain.balance(BUFFER, "USDC");
    // the buffer cannot cover everything: buy the most face affordable, class by class (R6)
    if (buys.reduce((n, b) => n + usdcFor(b.milli, rate), 0n) > affordable) {
      let money = affordable;
      // under WorkClaim's rounding (cost(m) = floor(m × rate ÷ 1e6)) the most a line can buy with `money` is floor(((money + 1) × 1e6 − 1) ÷ rate); taking exactly that leaves
      // less than one more mSIU's cost on the last line, which is AguLab's test (RollUnderbuys); found by the DW1 replay, 2026-11-05
      buys = buys.map((b) => {
        let m = ((money + 1n) * 1_000_000n - 1n) / rate;
        if (m > b.milli) m = b.milli;
        money -= usdcFor(m, rate);
        return { classId: b.classId, milli: m };
      });
      buys = buys.filter((b) => b.milli > 0n);
    }
    const bufferBefore = this.chain.balance(BUFFER, "USDC");
    const incomeBefore = this.chain.balance(INCOME, "USDC");
    let r: ReturnType<MemoryChain["roll"]>;
    try {
      r = this.chain.roll(AGU_ISSUER, {
        rate,
        frontLots: front,
        sales,
        buys,
        buyFrom: this.windowFrom(k + this.params.ladderWindows),
        buyTo: this.windowTo(k + this.params.ladderWindows),
      });
    } catch (e) {
      if (!(e instanceof ChainRule)) throw e;
      // as AguLab does: the whole step reverts, nothing moves, and the front lots stay in the reserve until they lapse at the window's end (NAV falls by their face)
      for (const o of this.frontOrders.filter((x) => x.forWindow === k))
        this.notify(
          o.agent,
          `your front-claim order for ${o.task} was not filled: the roll could not run (${e.message})`,
        );
      this.#log(AGU_ISSUER, "roll-buy", {
        summary: true,
        refused: e.message,
        frontLots: front.length,
      });
      return;
    }
    this.#bufferOut += r.cover;
    this.#bufferIn += r.carryToBuffer + r.dustToBuffer;
    this.#incomeIn += r.carryToIncome;
    for (const s of sales) {
      this.#log(AGU_ISSUER, "roll-sale", {
        to: s.buyer,
        tokenId: s.tokenId,
        milli: s.milli,
        usdc: usdcFor(s.milli, price),
      });
      this.frontPurchases.push({
        agent: s.buyer,
        window: k,
        milli: s.milli,
        usdc: usdcFor(s.milli, price),
      });
      const ct = this.chain.claimTypes.get(s.tokenId);
      this.notify(
        s.buyer,
        `arrival: ${show(s.milli, 3)} SIU of ${ct?.classId} work claim ${s.tokenId}, presentable in this window only; it lapses worthless if never presented`,
      );
    }
    for (const m of r.minted)
      this.#log(AGU_ISSUER, "roll-buy", {
        tokenId: m.tokenId,
        issuer: m.issuer,
        task: m.classId,
        milli: m.milli,
      });
    if (r.cover > 0n)
      this.#log(BUFFER, "roll-cover", {
        usdc: r.cover,
        bufferBefore,
        bufferAfter: this.chain.balance(BUFFER, "USDC"),
      });
    if (r.carryToBuffer + r.carryToIncome > 0n)
      this.#log(AGU_ISSUER, "roll-carry", {
        toBuffer: r.carryToBuffer,
        toIncome: r.carryToIncome,
        incomeBefore,
      });
    this.#log(AGU_ISSUER, "roll-buy", {
      summary: true,
      proceeds: r.proceeds,
      cost: r.cost,
      cover: r.cover,
      faceSold: r.faceSold,
      faceUnsold: r.faceUnsold,
      faceBought: r.faceBought,
      rollCostUsdc: r.cost - r.proceeds > 0n ? r.cost - r.proceeds : 0n,
    });
  }

  publishNav(): void {
    const { num, den } = this.chain.nav();
    const reserveNav = den === 0n ? null : new D(String(num)).div(String(den));
    // with the buffer: its USDC valued at the Commodity print, in SIU, added to the face
    const bufferSiu = new D(String(this.chain.balance(BUFFER, "USDC")))
      .div(1e6)
      .div(new D(String(this.commodityRate)).div(1e9));
    const withBuffer =
      den === 0n ? null : new D(String(num)).div(1000).plus(bufferSiu).times(1000).div(String(den));
    this.#log(AGU_ISSUER, "nav", {
      reserveNav: reserveNav?.toFixed(9) ?? null,
      navWithBuffer: withBuffer?.toFixed(9) ?? null,
      supply: this.chain.aguSupply,
      liveFaceMilli: this.chain.liveFace(),
      bufferUsdc: this.chain.balance(BUFFER, "USDC"),
      printNanoUsdPerSiu: this.commodityRate,
    });
  }

  /** before the last round: the one-time lapse warning for every claim of this window not yet presented (R12) */
  lapseWarnings(k: number): void {
    for (const [tokenId, holders] of this.chain.claims) {
      const ct = this.chain.claimTypes.get(tokenId);
      if (ct === undefined || ct.windowFrom !== this.windowFrom(k)) continue;
      for (const [holder, milli] of holders) {
        if (
          milli === 0n ||
          holder === RESERVE ||
          this.chain.everPresented.has(`${tokenId}|${holder}`)
        )
          continue;
        const key = `${tokenId}|${holder}`;
        if (this.warned.has(key)) continue;
        this.warned.add(key);
        this.notify(
          holder,
          `LAPSE WARNING: ${show(milli, 3)} SIU of ${ct.classId} claim ${tokenId} lapses worthless at the end of this window unless you present it now`,
        );
      }
    }
  }

  /** the end of window k: claims settle (expire or default), unmet needs and quotes lapse, issuers sell their AGU-lab income, sweeps, exits classified, NAV published */
  closeWindow(k: number): void {
    this.setTime(k, this.params.roundsPerWindow + 1);
    // a claim that arrived after the last round's warnings still gets its one warning before the window ends
    this.lapseWarnings(k);
    this.clock.now = this.windowTo(k) + 1;
    for (const [tokenId, holders] of [...this.chain.claims]) {
      const ct = this.chain.claimTypes.get(tokenId);
      if (ct === undefined || ct.windowTo !== this.windowTo(k)) continue;
      for (const [holder, milli] of [...holders]) {
        if (milli === 0n) continue;
        const r = this.chain.settleWindowClose(tokenId, holder, this.rates[ct.series]);
        const lapsedAfterWarning = this.warned.has(`${tokenId}|${holder}`);
        this.#log(GATE_RUNNER, "claim-close", {
          tokenId,
          holder,
          outcome: r.kind,
          milli: r.milli,
          usdc: r.usdc,
          lapsedAfterWarning,
          reserveLot: holder === RESERVE,
          retiredReserveLot: holder === RESERVE && this.chain.retired.has(tokenId),
        });
        if (r.kind === "expired" && holder !== RESERVE && !lapsedAfterWarning)
          throw new InvariantFailure(
            `R12: ${holder}'s claim ${tokenId} lapsed without its warning`,
          );
      }
    }
    for (const n of this.needs) if (n.window === k && n.status === "open") n.status = "lapsed";
    for (const q of this.quotes) {
      if (q.status === "accepted" && q.escrow !== undefined) {
        this.chain.escrowExpire(q.escrow);
        q.status = "lapsed";
        this.#log(GATE_RUNNER, "escrow-settle", {
          escrow: q.escrow,
          expired: true,
          refunded: q.agu,
        });
      } else if (q.status === "posted") q.status = "lapsed";
    }
    // issuers pay real inference bills: their AGU-lab income goes back to the participant, within its cap (an issuer exit, code not a model)
    for (const i of this.params.issuers) {
      const units = this.chain.balance(i.id, "AGU");
      if (units === 0n) continue;
      const room = this.participant.capThisWindow - this.participant.boughtBackThisWindow;
      const sell = units < room ? units : room;
      if (sell <= 0n) continue;
      try {
        const r = this.participant.buyBack(i.id, sell, this.commodityRate);
        this.#log(PARTICIPANT, "participant-buyback", {
          from: i.id,
          agu: r.units,
          usdc: r.usdc,
          issuerCode: true,
        });
      } catch (e) {
        if (!(e instanceof ParticipantRefused)) throw e;
        this.#log(i.id, "error", { refused: e.message });
      }
    }
    const day = k; // window k is day k of the series
    for (const a of this.params.agents.demand) {
      const m = this.params.mandates[a];
      if (m === undefined || !m.sweepDays.includes(day)) continue;
      const over = this.chain.balance(a, "USDC") - m.minUsdcBuffer;
      if (over > 0n) {
        this.chain.transfer("USDC", a, `OWNER-${a}`, over);
        this.#log(a, "sweep", { usdc: over, to: `OWNER-${a}` });
      }
    }
    this.#classifyExits(k);
    this.#updateDeliveryFlags();
    this.publishNav();
  }

  /** an exit followed in the same window by that agent's front-claim purchase, up to the amount exited, is a dollar cost with the sub-label (§4.2) */
  #classifyExits(k: number): void {
    const price = (this.commodityRate * (10_000n - this.params.reserve.discountBps)) / 10_000n;
    for (const e of this.exits.filter((x) => x.window === k && x.label === undefined)) {
      // the purchase decision is the order placed this window; the roll fills it at the next window's start
      const ordered = this.frontOrders
        .filter((f) => f.agent === e.agent && f.forWindow === k + 1)
        .reduce((n, f) => n + usdcFor(f.milli, price), 0n);
      e.label =
        ordered > 0n
          ? "dollar cost / dollar route to work"
          : "unclassified (tagged from reasoning)";
    }
  }

  /** R11: issuers below the delivery floor over the trailing windows are skipped from the next window; a skipped issuer clears after enough served probes */
  #updateDeliveryFlags(): void {
    for (const i of this.params.issuers) {
      const list = (this.delivery.get(i.id) ?? []).slice(-this.params.deliveryTrailingWindows);
      const presented = list.reduce((n, x) => n + x.presented, 0);
      const served = list.reduce((n, x) => n + x.served, 0);
      if (presented === 0) continue;
      const below = BigInt(served) * 10_000n < BigInt(presented) * this.params.deliveryFloorBps;
      const was = this.chain.skipped.has(i.id);
      if (below && !was) this.chain.setSkipped(i.id, true);
      // cleared by the published rule: the trailing ratio is back at the floor AND enough probes were served
      if (!below && was && (this.probesServed.get(i.id) ?? 0) >= this.params.probesToClear) {
        this.chain.setSkipped(i.id, false);
        this.probesServed.delete(i.id);
      }
      const now = this.chain.skipped.has(i.id);
      if (now !== was)
        this.#log(GATE_RUNNER, "routing", {
          issuer: i.id,
          skipped: now,
          served,
          presented,
          probesServed: this.probesServed.get(i.id) ?? 0,
        });
    }
  }

  // ---- invariants -----------------------------------------------------------------------------------------------------------------------------------
  checkInvariants(): void {
    const sumOf = (m: Map<string, bigint>): bigint => [...m.values()].reduce((a, b) => a + b, 0n);
    if (sumOf(this.chain.usdc) !== this.#mintedUsdc)
      throw new InvariantFailure(
        `USDC is conserved: ${sumOf(this.chain.usdc)} held, ${this.#mintedUsdc} minted`,
      );
    if (sumOf(this.chain.agu) !== this.chain.aguSupply)
      throw new InvariantFailure("AGU-lab balances sum to its supply");
    if (this.chain.balance(RESERVE, "USDC") !== 0n)
      throw new InvariantFailure("R5: the reserve holds no USDC between steps");
    if (this.chain.balance(BUFFER, "USDC") !== this.#bufferIn - this.#bufferOut)
      throw new InvariantFailure("the buffer moves only by seed, carry and roll cover");
    if (this.chain.balance(INCOME, "USDC") !== this.#incomeIn)
      throw new InvariantFailure("the income ledger only receives carry");
    // single grade (R3): every lot the reserve holds was issued by an issuer of the reserve's grade, not merely labelled with it
    for (const id of this.chain.reserveLots) {
      const issuer = this.params.issuers.find(
        (i) => i.id === this.chain.claimTypes.get(id)?.issuer,
      );
      if (issuer?.grade !== this.params.reserve.series)
        throw new InvariantFailure(
          `R3: reserve lot ${id} was issued by ${issuer?.id ?? "?"}, not a ${this.params.reserve.series} issuer`,
        );
    }
    for (const [, holders] of this.chain.claims)
      for (const [, v] of holders)
        if (v < 0n) throw new InvariantFailure("no negative claim balance");
  }

  /** every task type a demand agent may need */
  static readonly TASKS = TASKS;
}
