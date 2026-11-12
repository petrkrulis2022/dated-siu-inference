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
import { siuFirstForWindow } from "./board.js";
import type { EconomyLog } from "./log.js";
import {
  BUFFER,
  ChainRule,
  INCOME,
  MemoryChain,
  MIN_SETTLEMENT,
  PARTICIPANT,
  RESERVE,
  type Series,
} from "./memory-chain.js";
import type { EconomyParams, IssuerParams } from "./params.js";
import { Participant, ParticipantRefused } from "./participant.js";
import {
  acceptsPay,
  emptyRow,
  type Accept,
  type ClaimRequest,
  type Offer,
  type RecordRow,
  type V3aRun,
} from "./v3a-market.js";
import {
  microSiuForUsdcCeil,
  pairMicroSiu,
  pairUsdc,
  show,
  showMsiu,
  usdcFor,
  usdcForMicroSiu,
  usdcForMicroSiuCeil,
  type AguUnits,
  type MilliSiu,
  type NanoUsdPerSiu,
  type UsdcUnits,
} from "./units.js";

/** v2: which currency a transaction type's payment moves in, where the design note gives a real choice (items 1-5) */
export type PayUnit = "usdc" | "agu";

export type MicroSiu = bigint;
export const DATASET_FOR: Readonly<Record<TaskId, string>> = {
  "CR-VS": "perp",
  "CR-PL": "lending",
  "CR-UO": "tokens",
  "CR-SM": "stablecoins",
};
/** D146: the lab, paying for unsold front work in v3a (it replaces the finite buffer) */
export const LAB_SUBSIDY = "LAB-SUBSIDY";
export const DATA_AGENT = "DATA-AGENT";
export const GATE_RUNNER = "GATE-RUNNER";
export const AGU_ISSUER = "AGU-ISSUER";

/** v3a adds PROVIDER, the model agent that sells fSIU claims on the issuers' capacity */
export type Role = "research" | "demand" | "hedger" | "provider";

export type Action =
  | { tool: "pass" }
  | { tool: "message"; to: string; text: string }
  // v3a: `valueMilli` states an AGU-lab amount by its value in mSIU at today's NAV, the unit the board shows it in; the world converts it to units when it acts
  | { tool: "buy_agu"; usdc?: UsdcUnits; agu?: AguUnits; valueMilli?: MilliSiu }
  | { tool: "sell_agu"; agu?: AguUnits; valueMilli?: MilliSiu }
  | { tool: "redeem_agu"; agu?: AguUnits; valueMilli?: MilliSiu }
  | { tool: "present_claim"; claim: string }
  | { tool: "order_front_claim"; task: TaskId; milli: MilliSiu; pay?: PayUnit }
  // v2 item 2: exactly one of priceMicroSiu/priceUsdcMicro is set, enforced by parse.ts -- the RAW unit the quoting researcher chose, converted and locked in `#postQuote`.
  // v3a: `accepts` is which currencies the research agent will be paid in
  | { tool: "post_quote"; need: string; tasks: TaskId[]; priceMicroSiu?: MicroSiu; priceUsdcMicro?: UsdcUnits; accepts?: Accept }
  // v3a Phase 2 item 7: `claims` names work claims the demand agent holds for this window, paid instead of the quote's own unit (the fSIU lifecycle's "Transfer").
  // v3a: `pay` is the payer's choice among what the quote accepts
  | { tool: "accept_quote"; quote: string; claims?: string[]; pay?: "usdc" | "agu" | "claims" }
  // v3a: PROVIDER's standing offers and buyers' requests (D143), and creating AGU-lab in kind
  | {
      tool: "post_offer";
      issuer: string;
      task: TaskId;
      window: number;
      milli: MilliSiu;
      discountBps: bigint;
      accept: Accept;
      to: string;
      request?: string;
      replaces?: string;
    }
  | { tool: "withdraw_offer"; offer: string }
  | { tool: "decline_request"; request: string; reason: string }
  | { tool: "request_claims"; task: TaskId; window: number; milli: MilliSiu }
  | { tool: "buy_offer"; offer: string; milli: MilliSiu; pay: PayUnit }
  | { tool: "create_agu"; claim: string; milli: MilliSiu }
  | { tool: "buy_data"; dataset: string; pay?: PayUnit }
  | { tool: "commission_task"; tasks: TaskId[]; issuer: string; pay?: PayUnit }
  | { tool: "deliver_brief"; quote: string }
  | { tool: "buy_claims"; task: TaskId; milli: MilliSiu; windowsAhead: number; pay?: PayUnit }
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
  /** v3a Phase 2 item 7: the claim whose presentation produced this output, when one did -- so a brief paid in claims is built from the work those claims bought */
  fromClaim?: string;
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
  /** ALWAYS the SIU-equivalent, locked at post time -- unchanged meaning for every existing reader (comparability, display); for a usdc-unit quote this is the equivalent at post time, never re-derived */
  priceMicroSiu: MicroSiu;
  /** v2 item 2: which unit actually binds at acceptance */
  priceUnit: "siu" | "usdc";
  /** v2: the real binding amount when priceUnit === "usdc" */
  priceUsdcMicro?: UsdcUnits;
  status: "posted" | "accepted" | "delivered" | "failed" | "lapsed";
  escrow?: string;
  /** the AGU-lab amount actually escrowed, when priceUnit === "siu" */
  agu?: AguUnits;
  /** v2: the USDC amount actually escrowed, when priceUnit === "usdc" */
  usdcEscrowed?: UsdcUnits;
  /** v3a Phase 2 item 7: the work claims the demand agent paid with at acceptance */
  paidInClaims?: { tokenId: string; milli: MilliSiu }[];
  /**
   * D144: the account those claims are held in until the brief settles, as a currency payment is held in escrow -- released to the research agent on a passing brief,
   * returned to the payer if it fails or lapses
   */
  claimEscrow?: string;
  /** D144: escrowed claim face the research agent used for the brief's work (presentations that passed), which it pays back if the brief fails or lapses */
  claimsUsed?: { tokenId: string; milli: MilliSiu; series: Series }[];
  /** v3a: which currencies the research agent accepts payment in (work claims are always accepted, per the fSIU lifecycle) */
  accepts?: Accept;
  /** v3a: the Commodity print when the quote was posted -- the rate a payment in the other currency converts at */
  rateAtPost?: NanoUsdPerSiu;
  /**
   * v3a Phase 2 item 1: when and how the quote stopped being live. Set once, at settlement or lapse, when the escrow fields above are cleared: the board then drops the
   * quote, and any later action on it is refused with this as the reason.
   */
  closed?: { window: number; how: "paid" | "refunded" | "lapsed" | "lapsed-refunded" | "lapsed-paid-in-claims" };
}
export interface FrontOrder {
  agent: string;
  task: TaskId;
  milli: MilliSiu;
  forWindow: number;
  /** v2 item 4: default usdc (unchanged); "agu" pre-converts through the participant (same mechanism as buy_claims) before the roll's own USDC check runs, unchanged downstream */
  pay?: PayUnit;
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

/**
 * v2 item 8: a running per-agent economic objective -- a SCORING layer, never a real currency: no field here ever moves chain.usdc/chain.agu, so it cannot interact with, or
 * tilt, the real dual-currency mechanics items 1-5 added. `usdcNet`/`aguNet` are tracked NATIVELY per currency and never collapsed into one canonical unit internally (the
 * currency-neutrality requirement, [[feedback_design_scoring_for_currency_neutrality]]); `unmetMicroSiu` is a SIU-denominated penalty that touches neither currency, so it
 * cannot itself be a source of bias. `boardFor` converts all three to one combined figure ONLY for display, at the same live rate every other price on the board already uses.
 */
export interface ObjectiveLedger {
  usdcNet: bigint;
  aguNet: bigint;
  /** demand agents only: the cumulative cost of every need that lapsed unmet */
  unmetMicroSiu: bigint;
  /** the hedger only: briefs delivered on time vs. late or never, by count */
  onTime: number;
  late: number;
}

/** v3a: what a v3a world keeps beyond v2's state (docs/experiment-3a-design.md; D143); absent in a v1 or v2 world */
export interface V3aState {
  run: V3aRun;
  offers: Offer[];
  requests: ClaimRequest[];
  /** the public claims record, keyed `${issuer}|${window}` */
  record: Map<string, RecordRow>;
  /** the token types PROVIDER sold (tagged mints): every serve, default and expiry of these is PROVIDER's */
  providerTokens: Set<string>;
  /** spend per agent per window OF DELIVERY, micro-SIU (the mandate's cap counts the window the work is for) */
  spent: Map<string, Map<number, MicroSiu>>;
  /** each model agent's total starting value, micro-USD (USDC plus AGU-lab at the opening print), for buffers and sweeps */
  startValueMicroUsd: Map<string, UsdcUnits>;
  /** each issuer's list price per task before its class print's drift */
  baseTaskPrice: Record<string, Partial<Record<TaskId, MicroSiu>>>;
  /** this window's class-print factors, parts per million */
  classPpm: Partial<Record<TaskId, bigint>>;
  /** one task's work in mSIU of its grade, per class (fixed for the run: what a claim buys) */
  faces: Record<Series, Partial<Record<TaskId, MilliSiu>>>;
  /** PROVIDER's objective (decision 6): profit in SIU over the run, penalised for the defaults it causes */
  providerProfitMicroSiu: MicroSiu;
}

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
  /** v2 item 8: see `ObjectiveLedger`'s own doc comment -- a scoring layer, never a real currency */
  readonly objective = new Map<string, ObjectiveLedger>();
  /** v3a: see `V3aState`; undefined in a v1/v2 world */
  readonly v3a?: V3aState;
  forwardDelivered = 0;
  workSpendUsd = new D(0);
  window = 0;
  round = 0;
  #seq = 0;
  #mintedUsdc = 0n;
  #bufferIn = 0n;
  #bufferOut = 0n;
  /**
   * D144 (owner, 2026-11-12): the shadow NAV is what the reserve alone would support with no buffer support, as a share of NAV, in ppm. Each roll the buffer covers would,
   * without the buffer, have bought `cover` USDC less face at the print, so that roll's face is scaled by (face after the roll − that face) ÷ face after the roll; the share
   * compounds roll by roll. Carry into the buffer never raises it (without a buffer, the surplus would not stay in the reserve). Creation, redemption and defaults move NAV and
   * the shadow in proportion. Agents see this and NAV; never a NAV that includes the buffer.
   */
  #shadowPpm = 1_000_000n;
  /** D144: the buffer's draw at this window's roll, USDC base units (0 when no roll ran or the buffer paid nothing); D146: in v3a, the lab subsidy's */
  #bufferDraw = 0n;
  /** D146 (v3a): everything the lab subsidy has paid for unsold front work so far (the sum of every roll's cover) */
  #subsidyPaid = 0n;
  get subsidyPaid(): UsdcUnits {
    return this.#subsidyPaid;
  }
  get subsidyThisWindow(): UsdcUnits {
    return this.#bufferDraw;
  }
  get shadowNavPpm(): bigint {
    return this.#shadowPpm;
  }
  get bufferDrawThisWindow(): UsdcUnits {
    return this.#bufferDraw;
  }
  #incomeIn = 0n;

  constructor(
    readonly params: EconomyParams,
    readonly log: EconomyLog,
    readonly worker: TaskWorker,
    /** v2 item 10: no longer `readonly` -- `startWindow` updates this per window from `priceSchedule` when one is supplied, so a moving-price replay propagates through every existing read site (board, participant quotes, the roll, window-close settlement) with no other change */
    public rates: Readonly<Record<Series, NanoUsdPerSiu>>,
    /** each issuer's price per task, micro-SIU, from its measured cost per pass (WP0); v3a moves it each window with its class print */
    public taskPrice: Readonly<Record<string, Partial<Record<TaskId, MicroSiu>>>>,
    readonly dataSha: (window: number) => string,
    readonly dayLabel: (window: number) => string,
    readonly t0: number,
    readonly clock: { now: number },
    /** v2 item 8: how many windows this run has, for the hedger's own due-by-window schedule; opt-in -- absent, the bonus/penalty mechanism is a no-op, every existing caller unaffected */
    readonly totalWindows?: number,
    /** v2 item 10: window -> that day's real print rates, replayed instead of holding `rates` fixed for the whole run; opt-in, absent for every existing caller/test */
    readonly priceSchedule?: ReadonlyMap<number, Readonly<Record<Series, NanoUsdPerSiu>>>,
    /** v3a: the run (arm, volatility, price path) and each class's task face; absent, the world is v1/v2 exactly as before */
    v3aSetup?: { run: V3aRun; faces: V3aState["faces"] },
  ) {
    if (v3aSetup !== undefined) {
      if (params.v3a === undefined) throw new Error("a v3a run needs a v3a parameters file");
      this.v3a = {
        run: v3aSetup.run,
        offers: [],
        requests: [],
        record: new Map(),
        providerTokens: new Set(),
        spent: new Map(),
        startValueMicroUsd: new Map(),
        baseTaskPrice: taskPrice as Record<string, Partial<Record<TaskId, MicroSiu>>>,
        classPpm: {},
        faces: v3aSetup.faces,
        providerProfitMicroSiu: 0n,
      };
    }
    this.chain = new MemoryChain(
      {
        reserveSeries: params.reserve.series,
        minTenorSeconds: params.reserve.minTenorSeconds,
        discountBps: params.reserve.discountBps,
        // D146: v3a has no buffer to refill -- the lab subsidy funds each roll's cover exactly -- so carry goes to income
        bufferTarget: params.v3a !== undefined ? 0n : params.reserve.bufferTargetUsdc,
        // D145: v3a's roll uses v6's pooled direct mint; v1/v2 keep the deployed router's single-issuer placement
        ...(params.v3a !== undefined ? { pooledMint: true } : {}),
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
    if (this.v3a !== undefined && params.v3a !== undefined) this.roles.set(params.v3a.provider, "provider");
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
        // v2 fix 1 (owner, 2026-11-07): a refusal's own concrete numbers, where the throw site had any, ride along onto the agent's NEXT board (`lastResult`/`renderBoard`'s
        // "Your last action" line) -- not just the bare rule name, so a refused agent has something to react to instead of retrying the same action for rounds (found:
        // RESEARCH-1's own BelowMinSettlement loop in the first dev-test).
        const detail = e instanceof ChainRule && e.detail !== undefined ? e.detail : undefined;
        const suffix = detail === undefined ? "" : ` (${Object.entries(detail).map(([k, v]) => `${k} ${v}`).join(", ")})`;
        this.#log(agent, "error", {
          tool: action.tool,
          refused: e.message,
          ...(detail !== undefined ? { detail } : {}),
        });
        // v3a Phase 2 item 1: a refusal on a quote or a need names it, so an agent holding several can tell which one the chain refused
        const subject =
          action.tool === "accept_quote" || action.tool === "deliver_brief"
            ? `${action.quote}: `
            : action.tool === "post_quote"
              ? `${action.need}: `
              : action.tool === "buy_offer" || action.tool === "withdraw_offer"
                ? `${action.offer}: `
                : action.tool === "decline_request"
                  ? `${action.request}: `
                  : "";
        return this.#result(agent, { ok: false, note: `${subject}refused: ${e.message}${suffix}` });
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
        // v3a: an amount stated as AGU-lab value in mSIU buys the units that value is at today's NAV (rounded up, so the agent gets at least the value it asked for)
        return this.#buyAgu(agent, a.valueMilli !== undefined ? { agu: this.aguFor(a.valueMilli * 1_000n) } : a);
      case "sell_agu":
        return this.#sellAgu(agent, this.#unitsOf(agent, a), reasoning);
      case "redeem_agu": {
        const units = this.#unitsOf(agent, a);
        const min = this.params.v3a?.minRedeemMilli;
        if (min !== undefined && this.siuOf(units) < min * 1_000n)
          return { ok: false, note: `redeem at least ${this.#val(min * 1_000n)} of AGU-lab value (that is ${this.#val(this.siuOf(units))})` };
        return this.#redeem(agent, units);
      }
      case "present_claim":
        return this.#present(agent, a.claim);
      case "post_offer":
        return this.#postOffer(agent, role, a);
      case "withdraw_offer":
        return this.#withdrawOffer(agent, role, a.offer);
      case "decline_request":
        return this.#declineRequest(agent, role, a.request, a.reason);
      case "request_claims":
        return this.#requestClaims(agent, role, a);
      case "buy_offer":
        return this.#buyOffer(agent, role, a);
      case "create_agu":
        return this.#createAgu(agent, a.claim, a.milli);
      case "order_front_claim": {
        if (a.milli <= 0n) return { ok: false, note: "order at least 0.001 SIU" };
        if (this.v3a !== undefined) {
          if (a.pay === undefined) return { ok: false, note: "say which currency pays: usdc or agu" };
          // the roll sells at the discounted print; a demand agent's order counts against its cap for the window the work is for (the next one)
          const price = (this.commodityRate * (10_000n - this.params.reserve.discountBps)) / 10_000n;
          const value = (a.milli * 1_000n * price) / this.commodityRate;
          const refused = this.#mandateRefusal(agent, this.window + 1, value);
          if (refused !== undefined) return { ok: false, note: refused };
          this.#addSpend(agent, this.window + 1, value);
        }
        this.frontOrders.push({ agent, task: a.task, milli: a.milli, forWindow: this.window + 1, pay: a.pay });
        // this exact text is parsed by scoring.ts's FRONT_ORDER_TASK regex (kill criterion 4) -- its shape never varies with `pay`; the unit rides in its own field
        // (v3a Phase 2 item 3: buying ahead is reported per currency)
        this.#log(agent, "message", {
          to: AGU_ISSUER,
          text: `front-claim order: ${show(a.milli, 3)} SIU of ${a.task} for the next window`,
          pay: a.pay ?? "usdc",
        });
        return {
          ok: true,
          note:
            a.pay === "agu"
              ? `ordered ${this.#work(a.milli, this.#seriesOfTask(a.task))} of ${a.task} claims for the next window, paid in AGU-lab at the roll's discounted price`
              : `ordered ${this.#work(a.milli, this.#seriesOfTask(a.task))} of ${a.task} claims for the next window, paid in USDC at the roll`,
        };
      }
      case "post_quote":
        return this.#postQuote(agent, role, a);
      case "accept_quote":
        return this.#acceptQuote(agent, role, a.quote, a.claims, a.pay);
      case "buy_data":
        if (this.v3a !== undefined && a.pay === undefined) return { ok: false, note: "say which currency pays: usdc or agu" };
        return this.#buyData(agent, a.dataset, a.pay);
      case "commission_task": {
        if (a.tasks.length < 1 || a.tasks.length > 4 || new Set(a.tasks).size !== a.tasks.length)
          return { ok: false, note: "commission 1 to 4 different task types at once" };
        // v3a: no currency is ever chosen for an agent by default (a default would lean on the very choice the experiment measures)
        if (this.v3a !== undefined && a.pay === undefined) return { ok: false, note: "say which currency pays: usdc or agu" };
        const notes: string[] = [];
        let anyOk = false;
        for (const t of a.tasks) {
          const r = await this.#commission(agent, t, a.issuer, a.pay);
          anyOk ||= r.ok;
          notes.push(`${t}: ${r.note}`);
        }
        return { ok: anyOk, note: notes.join("; ") };
      }
      case "deliver_brief":
        return this.#deliverBrief(agent, role, a.quote);
      case "buy_claims":
        // v3a: claims are minted by PROVIDER's offers, never bought straight from an issuer at the plain print
        if (this.v3a !== undefined) return { ok: false, note: "buy claims from PROVIDER's offers (buy_offer), or ask for them (request_claims)" };
        return this.#buyClaims(agent, a.task, a.milli, a.windowsAhead, a.pay);
      case "deliver_forward":
        return this.#deliverForward(agent, role);
    }
  }

  /** v3a: an AGU-lab amount given in units, or as value in mSIU at today's NAV (rounded down: never more than the agent asked to part with) */
  #unitsOf(agent: string, a: { agu?: AguUnits; valueMilli?: MilliSiu }): AguUnits {
    if (a.valueMilli === undefined) return a.agu ?? 0n;
    const { num, den } = this.chain.nav();
    const units = num === 0n ? 0n : (a.valueMilli * 1_000n * den) / num;
    const held = this.chain.balance(agent, "AGU");
    // "all of it" stated as its value can round one unit past the balance: cap it there
    return units > held && units - held <= 1n ? held : units;
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
        return { ok: false, note: this.v3a === undefined ? `mandate: holding ceiling of ${show(ceiling)} SIU in AGU-lab` : `mandate: holding ceiling of ${this.#val(ceiling)} in AGU-lab` };
      if (
        this.chain.balance(agent, "USDC") - this.participant.quote(units, rate).ask <
        m.minUsdcBuffer
      )
        return { ok: false, note: `mandate: keep at least ${this.#usd(m.minUsdcBuffer)}` };
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
          note:
            this.v3a === undefined
              ? `partly filled: bought ${show(r.units)} of the ${show(units)} AGU-lab asked, for ${show(r.usdc)} USDC; the issuers have no more capacity this window`
              : `partly filled: bought ${this.#agu(r.units)} of the ${this.#agu(units)} asked, for ${this.#usd(r.usdc)}; the issuers have no more capacity this window`,
        }
      : { ok: true, note: `bought ${this.#agu(r.units)} for ${this.#usd(r.usdc)}` };
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
      if (room <= 0n) {
        // D145: the issuers' headroom ran out before the creation was done -- v6's issuance limit binding, which makes a v3a run invalid
        if (this.v3a !== undefined)
          this.#log(PARTICIPANT, "issuance-limit", {
            what: onDemand ? "on-demand creation" : "ladder creation",
            task: classId,
            forWindow: k,
            wanted: milli,
            placed: made,
            ...(keep > 0n ? { keptForTheRoll: keep } : {}),
          });
        break;
      }
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
        if (this.v3a !== undefined) this.#row(this.chain.claimTypes.get(id)?.issuer as string, k).mintedMilli += m;
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
  /**
   * Found 2026-11-08 checking a counted run's cap arithmetic: this used to scan every issuer's every task price, including frontier-grade CR-VS (ISSUER-F) -- a task no
   * brief ever contains (every real needsSchedule call site -- scoring.ts, economy-window.ts, chain-replay.ts, studio/roster.ts -- draws needs from
   * `TASKS.filter(t => t !== "CR-VS")`). CR-VS's price sits on a wholly different cost basis (~60x the commodity tasks), so including it inflated the reference brief
   * price well past what a real two-task brief can ever actually cost, silently loosening `holdingCeilingMicroSiu`'s own check (more permissive than intended, so it
   * never visibly refused anything) and distorting the board's own displayed figure, which agents read to decide how much AGU-lab to hold.
   */
  referenceBriefMicroSiu(): MicroSiu {
    const prices = Object.values(this.taskPrice).flatMap((p) =>
      Object.entries(p)
        .filter(([task]) => task !== "CR-VS")
        .map(([, price]) => price as MicroSiu),
    );
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
    return { ok: true, note: `sold ${this.#agu(r.units)} for ${this.#usd(r.usdc)}` };
  }

  #redeem(agent: string, units: AguUnits): Outcome {
    const r = this.chain.redeem(agent, units);
    this.#log(agent, "redeem", { agu: units, lots: r.lots });
    for (const l of r.lots) {
      const ct = this.chain.claimTypes.get(l.tokenId);
      // R12: every claim received in kind gets the same arrival notice with its deadline as a bought claim
      this.notify(
        agent,
        `arrival: ${this.#work(l.milli, ct?.series)} of ${ct?.classId} work claim ${l.tokenId}, presentable from window ${this.#windowOf(ct?.windowFrom ?? 0)} until its end; it lapses worthless if never presented`,
      );
    }
    return {
      ok: true,
      note: `redeemed ${this.#agu(units)} for ${r.lots.length} claim lot(s) in kind`,
    };
  }
  #windowOf(t: number): number {
    return Math.floor((t - this.t0) / this.params.secondsPerWindow);
  }

  async #present(agent: string, tokenId: string): Promise<Outcome> {
    const ct = this.chain.claimTypes.get(tokenId);
    if (ct === undefined) return { ok: false, note: `no claim ${tokenId}` };
    // D144: a research agent may present claims held in escrow for one of its accepted briefs, on the escrow's behalf, for that brief's work; the output is its own
    const escrowed =
      this.chain.claimBalance(agent, tokenId) > 0n
        ? undefined
        : this.quotes.find(
            (q) =>
              q.researcher === agent &&
              q.status === "accepted" &&
              q.claimEscrow !== undefined &&
              this.chain.claimBalance(q.claimEscrow, tokenId) > 0n,
          );
    const holder = escrowed?.claimEscrow ?? agent;
    const milli = this.chain.claimBalance(holder, tokenId);
    // one presentation is one task's work (TASK_MILLI), or what is left of the claim. v3a: one task of a class is that class's fixed face (the work a claim buys,
    // `taskFaces`), and a holding smaller than one task cannot be presented -- a remnant would otherwise buy a whole task
    const face = this.v3a?.faces[ct.series][ct.classId as TaskId];
    if (this.v3a !== undefined && face === undefined) return { ok: false, note: `no task face for ${ct.classId} claims` };
    if (face !== undefined && milli < face)
      return { ok: false, note: `one ${ct.classId} task takes ${this.#work(face, ct.series)} of claim; you hold ${this.#work(milli, ct.series)} of ${tokenId} (holdings of the same claim add up)` };
    const take = face ?? (milli < TASK_MILLI ? milli : TASK_MILLI);
    if (take === 0n) return { ok: false, note: `you hold none of ${tokenId}` };
    this.chain.present(holder, tokenId);
    this.#log(agent, "claim-present", { tokenId, issuer: ct.issuer, task: ct.classId, ...(escrowed !== undefined ? { fromEscrow: holder, quote: escrowed.id } : {}) });
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
    this.chain.serve(ct.issuer, tokenId, holder, take, out.passed);
    if (escrowed !== undefined && out.passed)
      escrowed.claimsUsed = [...(escrowed.claimsUsed ?? []), { tokenId, milli: take, series: ct.series }];
    if (this.v3a !== undefined) {
      const row = this.#row(ct.issuer, this.window);
      row.presented++;
      if (out.passed) {
        row.served++;
        row.servedMilli += take;
        if (this.v3a.providerTokens.has(tokenId)) this.#providerPaysIssuer(ct.issuer, ct.classId as TaskId);
      }
    }
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
    this.#addOutput(agent, ct.classId as TaskId, out, ct.issuer, tokenId);
    return {
      ok: true,
      note: `${ct.issuer} did ${ct.classId} work on your claim: ${out.passed ? "PASSED" : "FAILED (the claim stays with you; you may present it again this window)"}`,
    };
  }
  #addOutput(owner: string, task: TaskId, out: WorkOutcome, issuer: string, fromClaim?: string): TaskOutput {
    const o: TaskOutput = {
      id: this.#id("out"),
      owner,
      task,
      passed: out.passed,
      dataSha: out.dataSha,
      issuer,
      window: this.window,
      used: false,
      ...(fromClaim !== undefined ? { fromClaim } : {}),
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
  // ---- v3a: payments, mandates and value ------------------------------------------------------------------------------------------------------------
  /** v3a: whether `payer` holds enough of EACH currency to pay `value` micro-SIU in it (the exchange measure counts only payments where it did) */
  #canPayBoth(payer: string, value: MicroSiu): boolean {
    return (
      this.chain.balance(payer, "USDC") >= usdcForMicroSiuCeil(value, this.commodityRate) &&
      this.chain.balance(payer, "AGU") >= this.aguFor(value)
    );
  }

  /**
   * v3a: one payment, recorded when the payer commits it (an escrow opened counts, whether or not it later settles), before any money moves, for the exchange measure:
   * AGU-lab's share of payments by value, counting only payments where the payer could pay in both and the payee accepted both. `forced` (a sweep's conversion) and
   * `scripted` (code paying on an agent's behalf) are kept out of that measure, which counts freely chosen payments only (the owner, D143).
   */
  #payment(
    payer: string,
    payee: string,
    what: string,
    currency: PayUnit | "claims",
    value: MicroSiu,
    opts: {
      payeeAcceptsBoth: boolean;
      forced?: boolean;
      scripted?: boolean;
      forWindow?: number;
      ref?: string;
      /** read before the money moved, when the record is written after (so a refused transfer leaves no payment behind) */
      couldPayBoth?: boolean;
    },
  ): void {
    if (this.v3a === undefined) return;
    this.#log(payer, "payment", {
      payee,
      what,
      currency,
      valueMicroSiu: value,
      valueMicroUsd: usdcForMicroSiuCeil(value, this.commodityRate),
      couldPayBoth: opts.couldPayBoth ?? this.#canPayBoth(payer, value),
      payeeAcceptsBoth: opts.payeeAcceptsBoth,
      forced: opts.forced === true,
      scripted: opts.scripted === true,
      forWindow: opts.forWindow ?? this.window,
      ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
    });
  }

  /** v3a: the reference brief a mandate's cap counts in: two tasks of the dearest Commodity class, at the brief markup, micro-SIU */
  v3aReferenceBriefMicroSiu(): MicroSiu {
    const faces = Object.values(this.v3a?.faces.commodity ?? {}) as MilliSiu[];
    const max = faces.reduce((a, b) => (b > a ? b : a), 0n);
    return (2n * max * 1_000n * this.params.briefMarkupBps) / 10_000n;
  }
  /** v3a: a demand agent's spend cap for one window of delivery, micro-SIU; undefined for an agent without a v3a mandate */
  v3aCapMicroSiu(agent: string): MicroSiu | undefined {
    const m = this.params.v3a?.mandates[agent];
    return m === undefined ? undefined : BigInt(m.capBriefsPerWindow) * this.v3aReferenceBriefMicroSiu();
  }
  spentFor(agent: string, window: number): MicroSiu {
    return this.v3a?.spent.get(agent)?.get(window) ?? 0n;
  }
  #addSpend(agent: string, window: number, value: MicroSiu): void {
    if (this.v3a === undefined) return;
    const m = this.v3a.spent.get(agent) ?? new Map<number, MicroSiu>();
    m.set(window, (m.get(window) ?? 0n) + value);
    this.v3a.spent.set(agent, m);
  }
  /** v3a: a demand agent's buffer, micro-USD (its mandate's share of its starting value) */
  v3aBufferMicroUsd(agent: string): UsdcUnits | undefined {
    const m = this.params.v3a?.mandates[agent];
    const start = this.v3a?.startValueMicroUsd.get(agent);
    return m === undefined || start === undefined ? undefined : (start * m.minValueBufferBps) / 10_000n;
  }

  /** micro-SIU of the Commodity grade in one micro-SIU of `series` (Frontier converts through the two prints) */
  #toCommodity(microSiu: bigint, series: Series): MicroSiu {
    return series === "commodity" ? microSiu : (microSiu * this.rates[series]) / this.rates.commodity;
  }
  /** v3a: the live claims `agent` holds, valued at face in Commodity micro-SIU; `windows` narrows them to claims presentable in those windows */
  claimsValueMicroSiu(agent: string, windows?: (k: number) => boolean): MicroSiu {
    let v = 0n;
    for (const [tokenId, holders] of this.chain.claims) {
      const milli = holders.get(agent) ?? 0n;
      const ct = this.chain.claimTypes.get(tokenId);
      if (milli === 0n || ct === undefined || ct.windowTo <= this.clock.now) continue;
      if (windows !== undefined && !windows(this.#windowOf(ct.windowFrom))) continue;
      v += this.#toCommodity(milli * 1_000n, ct.series);
    }
    return v;
  }
  /** v3a: everything `agent` holds, valued at today's print, micro-USD: USDC, AGU-lab at mid (NAV × print) and live claims at face */
  valueMicroUsd(agent: string): UsdcUnits {
    const rate = this.commodityRate;
    return (
      this.chain.balance(agent, "USDC") +
      usdcForMicroSiu(this.siuOf(this.chain.balance(agent, "AGU")) + this.claimsValueMicroSiu(agent), rate)
    );
  }

  /**
   * v3a: a demand agent's mandate (docs/experiment-3a-design.md, Cast): spend counts against the window the work is for, up to its cap in reference briefs, and it keeps a
   * minimum total value in either currency. Returns the refusal, or undefined when the spend is within both.
   */
  #mandateRefusal(agent: string, forWindow: number, value: MicroSiu): string | undefined {
    const cap = this.v3aCapMicroSiu(agent);
    if (cap === undefined) return undefined;
    const after = this.spentFor(agent, forWindow) + value;
    if (after > cap)
      return `over spend cap for window ${forWindow}: ${this.#val(after)} of ${this.#val(cap)} (already committed ${this.#val(this.spentFor(agent, forWindow))}, this ${this.#val(value)})`;
    const buffer = this.v3aBufferMicroUsd(agent) ?? 0n;
    const left = this.valueMicroUsd(agent) - usdcForMicroSiuCeil(value, this.commodityRate);
    if (left < buffer) return `would leave ${this.#usd(left)} of value, below your minimum of ${this.#usd(buffer)}`;
    return undefined;
  }

  /** v2 item 8: this agent's objective ledger, created at zero on first touch */
  #objectiveFor(agent: string): ObjectiveLedger {
    let o = this.objective.get(agent);
    if (o === undefined) {
      o = { usdcNet: 0n, aguNet: 0n, unmetMicroSiu: 0n, onTime: 0, late: 0 };
      this.objective.set(agent, o);
    }
    return o;
  }

  #postQuote(agent: string, role: Role, a: Extract<Action, { tool: "post_quote" }>): Outcome {
    // v3a Phase 2 item 1: no quote exists yet, so every refusal here names the need it was for, and why
    if (role !== "research") return { ok: false, note: `${a.need}: only research agents post brief quotes` };
    const need = this.needs.find((n) => n.id === a.need);
    if (need === undefined) return { ok: false, note: `${a.need}: no such need` };
    if (need.status !== "open")
      return {
        ok: false,
        note: `${a.need}: ${need.status === "met" ? "already met" : `lapsed at the end of window ${need.window}`}`,
      };
    if (need.window !== this.window)
      return { ok: false, note: `${a.need}: due in window ${need.window}, and quotes are for this window's needs (window ${this.window})` };
    if (a.tasks.length < 2 || a.tasks.length > 4 || new Set(a.tasks).size !== a.tasks.length)
      return { ok: false, note: `${a.need}: a brief bundles 2 to 4 different task types` };
    if (!need.tasks.every((t) => a.tasks.includes(t)))
      return { ok: false, note: `${a.need}: the quote must cover the need's tasks: ${need.tasks.join(", ")}` };
    // v2 item 2: a quote binds in whichever unit the researcher named; the OTHER unit's figure is locked now, at post time, never re-derived at acceptance (the design note's rate-locking rule)
    const rate = this.commodityRate;
    const priceUnit: "siu" | "usdc" = a.priceUsdcMicro !== undefined ? "usdc" : "siu";
    const priceUsdcMicro = priceUnit === "usdc" ? (a.priceUsdcMicro as UsdcUnits) : undefined;
    const priceMicroSiu =
      priceUnit === "usdc" ? microSiuForUsdcCeil(priceUsdcMicro as UsdcUnits, rate) : (a.priceMicroSiu as MicroSiu);
    if (priceMicroSiu <= 0n) return { ok: false, note: `${a.need}: a price must be above zero` };
    // v3a: the research agent states which currencies it will be paid in (none is assumed for it); work claims are always accepted (the fSIU lifecycle's "Transfer")
    if (this.v3a !== undefined && a.accepts === undefined)
      return { ok: false, note: `${a.need}: say which currencies you accept: usdc, agu or both` };
    const q: Quote = {
      id: this.#id("quote"),
      researcher: agent,
      demand: need.agent,
      need: need.id,
      tasks: a.tasks,
      priceMicroSiu,
      priceUnit,
      priceUsdcMicro,
      status: "posted",
      ...(this.v3a !== undefined ? { accepts: a.accepts, rateAtPost: rate } : {}),
    };
    this.quotes.push(q);
    this.#log(agent, "quote", {
      quote: q.id,
      to: need.agent,
      need: need.id,
      tasks: a.tasks,
      priceMicroSiu,
      priceUnit,
      ...(priceUsdcMicro !== undefined ? { priceUsdcMicro } : {}),
      ...(q.accepts !== undefined ? { accepts: q.accepts } : {}),
    });
    this.notify(
      need.agent,
      this.v3a !== undefined
        ? `quote ${q.id} from ${agent}: a brief on ${a.tasks.join(" + ")} for ${priceUnit === "usdc" ? this.#usd(priceUsdcMicro ?? 0n) : this.#val(priceMicroSiu)}, accepting ${q.accepts === "both" ? "USDC or AGU-lab" : q.accepts === "usdc" ? "USDC" : "AGU-lab"} (or work claims for this window), escrowed until a passing brief`
        : priceUnit === "usdc"
          ? `quote ${q.id} from ${agent}: a brief on ${a.tasks.join(" + ")} for ${show(priceUsdcMicro as UsdcUnits)} USDC, payable on delivery of a passing brief`
          : `quote ${q.id} from ${agent}: a brief on ${a.tasks.join(" + ")} for ${showMsiu(priceMicroSiu)}, payable in AGU-lab on delivery of a passing brief`,
    );
    return { ok: true, note: `quote ${q.id} posted to ${need.agent}` };
  }

  /**
   * v3a Phase 2 item 1: why a quote is no longer open to accept or to deliver, in words its holder can act on -- `side` is who is asking: the demand agent who would pay
   * ("buyer") or the research agent who would deliver ("seller").
   */
  #whyNotOpen(q: Quote, side: "buyer" | "seller"): string {
    const w = q.closed?.window ?? this.window;
    switch (q.status) {
      case "accepted":
        return q.paidInClaims !== undefined
          ? "already accepted, paid in work claims held in escrow"
          : `already accepted, ${q.usdcEscrowed !== undefined ? this.#usd(q.usdcEscrowed) : this.#agu(q.agu ?? 0n)} in escrow`;
      case "delivered":
        return `already paid in window ${w}`;
      case "failed":
        return `its brief failed in window ${w} and ${side === "buyer" ? "your payment was" : "the buyer was"} refunded`;
      case "lapsed":
        if (q.closed?.how === "lapsed-refunded")
          return `lapsed at the end of window ${w}; its escrow was refunded to ${side === "buyer" ? "you" : "the buyer"}`;
        if (q.closed?.how === "lapsed-paid-in-claims")
          return side === "buyer"
            ? `lapsed undelivered at the end of window ${w}; the claims you paid with were returned to you`
            : `lapsed undelivered at the end of window ${w}; the escrowed claims were returned to the buyer`;
        return `lapsed at the end of window ${w}`;
      case "posted":
        return side === "buyer" ? "still posted" : `not accepted yet by ${q.demand}`;
    }
  }

  #acceptQuote(
    agent: string,
    role: Role,
    id: string,
    claims?: readonly string[],
    pay?: "usdc" | "agu" | "claims",
  ): Outcome {
    if (role !== "demand") return { ok: false, note: `${id}: only demand agents accept brief quotes` };
    const q = this.quotes.find((x) => x.id === id);
    if (q === undefined) return { ok: false, note: `${id}: no such quote` };
    if (q.demand !== agent) return { ok: false, note: `${id}: offered to ${q.demand}, not to you` };
    if (q.status !== "posted") return { ok: false, note: `${id}: ${this.#whyNotOpen(q, "buyer")}` };
    const other = this.quotes.find((x) => x.need === q.need && x.status === "accepted");
    if (other !== undefined) return { ok: false, note: `${id}: you already accepted ${other.id} for ${q.need}` };
    if (this.v3a !== undefined) {
      // v3a: the payer chooses the currency among what the quote accepts; no currency is chosen for it
      const how = claims !== undefined && claims.length > 0 ? "claims" : pay;
      if (how === undefined) return { ok: false, note: `${id}: say how you pay: usdc, agu or claims` };
      if (how !== "claims" && !acceptsPay(q.accepts ?? "both", how))
        return { ok: false, note: `${id}: ${q.researcher} accepts ${q.accepts} on this quote (or work claims)` };
      if (how === "claims" && (claims === undefined || claims.length === 0))
        return { ok: false, note: `${id}: name the claims you pay with` };
      const refused = this.#mandateRefusal(agent, this.window, q.priceMicroSiu);
      if (refused !== undefined) return { ok: false, note: `${id}: ${refused}` };
      if (how === "claims") return this.#acceptWithClaims(agent, q, claims as string[], 0n);
      return this.#openQuoteEscrow(agent, q, how, 0n, 0n);
    }
    // the mandate's spend limit is stated in AGU-lab terms regardless of which rail actually pays -- a value cap, not a currency-specific one (item 3)
    const aguEquivalent = this.aguFor(q.priceMicroSiu);
    const m = this.params.mandates[agent];
    const spent = this.spentAguThisWindow.get(agent) ?? 0n;
    if (m !== undefined && spent + aguEquivalent > m.spendLimitAguPerWindow)
      return {
        ok: false,
        note: `${id}: over spend cap: ${show(spent + aguEquivalent)} of ${show(m.spendLimitAguPerWindow)} AGU-lab-equivalent this window (${show(spent)} already spent, this quote ${show(aguEquivalent)})`,
      };
    if (claims !== undefined && claims.length > 0) return this.#acceptWithClaims(agent, q, claims, spent + aguEquivalent);
    return this.#openQuoteEscrow(agent, q, q.priceUnit === "usdc" ? "usdc" : "agu", spent, aguEquivalent);
  }

  /**
   * Escrows a quote's price in `payIn` (v1/v2: always the quote's own unit; v3a: the payer's choice). The other currency's amount comes from the price locked at post time:
   * USDC at the print then (`rateAtPost`), AGU-lab at today's NAV, as v2 already priced an SIU quote. `spent`/`aguEquivalent` feed v2's per-window AGU-lab counter only.
   */
  #openQuoteEscrow(agent: string, q: Quote, payIn: PayUnit, spent: AguUnits, aguEquivalent: AguUnits): Outcome {
    const escrow = this.#id("escrow");
    const both = this.v3a !== undefined && this.#canPayBoth(agent, q.priceMicroSiu);
    const recordPayment = (): void =>
      this.#payment(agent, q.researcher, "brief", payIn, q.priceMicroSiu, {
        payeeAcceptsBoth: q.accepts === "both",
        ref: q.id,
        couldPayBoth: both,
      });
    // escrowOpen can refuse (the buyer's real balance is short): commit no state at all -- status, escrow id, the spend counter -- until it actually succeeds, the same
    // order #commission already uses. Setting these first (as this branch once did) left a quote permanently "accepted" with no real escrow the one time a demand agent's
    // own balance came up short, surviving to crash window-close's cleanup trying to expire an escrow that was never opened (found live testing D137, native tool-calling's
    // own near-100% execution rate reaching this for the first time).
    if (payIn === "usdc") {
      const usdcOwed =
        q.priceUnit === "usdc"
          ? (q.priceUsdcMicro as UsdcUnits)
          : usdcForMicroSiuCeil(q.priceMicroSiu, q.rateAtPost ?? this.commodityRate);
      this.chain.escrowOpen(escrow, "USDC", agent, q.researcher, GATE_RUNNER, usdcOwed, this.windowTo(this.window));
      recordPayment();
      this.spentAguThisWindow.set(agent, spent + aguEquivalent);
      this.#addSpend(agent, this.window, q.priceMicroSiu);
      q.status = "accepted";
      q.escrow = escrow;
      q.usdcEscrowed = usdcOwed;
      this.#log(agent, "escrow-open", {
        escrow,
        quote: q.id,
        to: q.researcher,
        usdc: usdcOwed,
        priceMicroSiu: q.priceMicroSiu,
      });
      this.notify(
        q.researcher,
        `${agent} accepted quote ${q.id}: ${this.#usd(usdcOwed)} is in escrow, released when you deliver a passing brief this window`,
      );
      return { ok: true, note: `accepted ${q.id}: ${this.#usd(usdcOwed)} in escrow` };
    }
    const units = this.v3a !== undefined ? this.aguFor(q.priceMicroSiu) : aguEquivalent;
    this.chain.escrowOpen(escrow, "AGU", agent, q.researcher, GATE_RUNNER, units, this.windowTo(this.window));
    recordPayment();
    this.spentAguThisWindow.set(agent, spent + aguEquivalent);
    this.#addSpend(agent, this.window, q.priceMicroSiu);
    q.status = "accepted";
    q.escrow = escrow;
    q.agu = units;
    this.#log(agent, "escrow-open", {
      escrow,
      quote: q.id,
      to: q.researcher,
      agu: units,
      priceMicroSiu: q.priceMicroSiu,
    });
    this.notify(
      q.researcher,
      `${agent} accepted quote ${q.id}: ${this.#agu(units)} is in escrow, released when you deliver a passing brief this window`,
    );
    return { ok: true, note: `accepted ${q.id}: ${this.#agu(units)} in escrow` };
  }

  // ---- v3a: PROVIDER's offers, buyers' requests, creation in kind ---------------------------------------------------------------------------------
  #issuerSeries(issuerId: string): Series | undefined {
    return this.params.issuers.find((i) => i.id === issuerId)?.grade;
  }

  /** v3a (D143): PROVIDER posts a standing offer, or revises one (`replaces`), or answers a buyer's request with one (`request`) */
  #postOffer(agent: string, role: Role, a: Extract<Action, { tool: "post_offer" }>): Outcome {
    if (role !== "provider" || this.v3a === undefined || this.params.v3a === undefined)
      return { ok: false, note: "only PROVIDER posts claim offers" };
    const rules = this.params.v3a.providerRules;
    const series = this.#issuerSeries(a.issuer);
    if (series === undefined) return { ok: false, note: `no issuer ${a.issuer}` };
    if (!this.chain.bondLots.has(`${a.issuer}|${a.task}`))
      return { ok: false, note: `${a.issuer} bonds no ${a.task} claims (it may still take commissions for it)` };
    if (a.window < this.window || a.window > this.window + rules.maxWindowsAhead)
      return { ok: false, note: `offer claims for windows ${this.window} to ${this.window + rules.maxWindowsAhead}` };
    if (a.milli <= 0n) return { ok: false, note: `offer at least ${this.#work(1n, this.#seriesOfTask(a.task))}` };
    const room = this.chain.headroom(a.issuer, a.task);
    if (a.milli > room)
      return { ok: false, note: `${a.issuer} has headroom for ${this.#work(room, this.#seriesOfTask(a.task))} of ${a.task}, not ${this.#work(a.milli, this.#seriesOfTask(a.task))}` };
    if (a.discountBps < rules.discountMinBps || a.discountBps > rules.discountMaxBps)
      return { ok: false, note: `the discount must be from ${rules.discountMinBps} to ${rules.discountMaxBps} bps (negative is a premium)` };
    if (a.to !== "all" && (this.roles.get(a.to) === undefined || this.roles.get(a.to) === "provider"))
      return { ok: false, note: `offer to "all" or to one buyer by id, not ${a.to}` };
    const replaced = a.replaces === undefined ? undefined : this.v3a.offers.find((o) => o.id === a.replaces);
    if (a.replaces !== undefined && replaced?.status !== "live")
      return { ok: false, note: `${a.replaces}: no live offer of yours to revise` };
    const request = a.request === undefined ? undefined : this.v3a.requests.find((r) => r.id === a.request);
    if (a.request !== undefined && request?.status !== "open")
      return { ok: false, note: `${a.request}: no open request to answer` };
    const offer: Offer = {
      id: this.#id("offer"),
      issuer: a.issuer,
      task: a.task,
      series,
      window: a.window,
      milliLeft: a.milli,
      discountBps: a.discountBps,
      accept: a.accept,
      to: a.to,
      ...(request !== undefined ? { request: request.id } : {}),
      postedWindow: this.window,
      postedRound: this.round,
      status: "live",
    };
    if (replaced !== undefined) replaced.status = "replaced";
    if (request !== undefined) {
      request.status = "answered";
      request.answer = offer.id;
      this.notify(request.buyer, `PROVIDER answered your request ${request.id} with offer ${offer.id}`);
    }
    this.v3a.offers.push(offer);
    this.#log(agent, "offer", {
      offer: offer.id,
      issuer: a.issuer,
      task: a.task,
      series,
      forWindow: a.window,
      milli: a.milli,
      discountBps: a.discountBps,
      accept: a.accept,
      to: a.to,
      ...(request !== undefined ? { request: request.id } : {}),
      ...(replaced !== undefined ? { replaces: replaced.id } : {}),
    });
    if (a.to !== "all") this.notify(a.to, `PROVIDER offers you ${this.#work(a.milli, offer.series)} of ${a.task} claims for window ${a.window} (${offer.id})`);
    return { ok: true, note: `offer ${offer.id} posted${replaced !== undefined ? `, replacing ${replaced.id}` : ""}` };
  }

  #withdrawOffer(agent: string, role: Role, id: string): Outcome {
    if (role !== "provider" || this.v3a === undefined) return { ok: false, note: `${id}: only PROVIDER withdraws offers` };
    const o = this.v3a.offers.find((x) => x.id === id);
    if (o === undefined) return { ok: false, note: `${id}: no such offer` };
    if (o.status !== "live") return { ok: false, note: `${id}: already ${o.status}` };
    o.status = "withdrawn";
    this.#log(agent, "offer", { offer: id, withdrawn: true });
    return { ok: true, note: `offer ${id} withdrawn` };
  }

  #declineRequest(agent: string, role: Role, id: string, reason: string): Outcome {
    if (role !== "provider" || this.v3a === undefined) return { ok: false, note: `${id}: only PROVIDER answers requests` };
    const r = this.v3a.requests.find((x) => x.id === id);
    if (r === undefined) return { ok: false, note: `${id}: no such request` };
    if (r.status !== "open") return { ok: false, note: `${id}: already ${r.status}` };
    r.status = "declined";
    r.answer = reason;
    this.#log(agent, "claim-request", { request: id, declined: true, reason });
    this.notify(r.buyer, `PROVIDER declined your request ${id}: ${reason}`);
    return { ok: true, note: `request ${id} declined` };
  }

  /** v3a (D143): a buyer asks PROVIDER for claims; the request stays on the board until PROVIDER answers it or the window it was posted in closes */
  #requestClaims(agent: string, role: Role, a: Extract<Action, { tool: "request_claims" }>): Outcome {
    if (this.v3a === undefined || this.params.v3a === undefined) return { ok: false, note: "there is no claims provider in this market" };
    if (role === "provider") return { ok: false, note: "PROVIDER answers requests; it does not post them" };
    const ahead = this.params.v3a.providerRules.maxWindowsAhead;
    if (a.window < this.window || a.window > this.window + ahead)
      return { ok: false, note: `ask for claims for windows ${this.window} to ${this.window + ahead}` };
    if (a.milli <= 0n) return { ok: false, note: `ask for at least ${this.#work(1n, this.#seriesOfTask(a.task))}` };
    if (![...this.chain.bondLots.keys()].some((k) => k.endsWith(`|${a.task}`)))
      return { ok: false, note: `no issuer bonds ${a.task} claims` };
    const r: ClaimRequest = {
      id: this.#id("request"),
      buyer: agent,
      task: a.task,
      window: a.window,
      milli: a.milli,
      postedWindow: this.window,
      postedRound: this.round,
      status: "open",
    };
    this.v3a.requests.push(r);
    this.#log(agent, "claim-request", { request: r.id, task: a.task, forWindow: a.window, milli: a.milli });
    this.notify(this.params.v3a.provider, `${agent} asks for ${this.#work(a.milli, this.#seriesOfTask(a.task))} of ${a.task} claims for window ${a.window} (${r.id})`);
    return { ok: true, note: `request ${r.id} posted to PROVIDER` };
  }

  /** v3a: a buyer buys claims from a live offer: paid to PROVIDER at once in a currency the offer accepts, minted from the offer's issuer, PROVIDER's own token type */
  #buyOffer(agent: string, role: Role, a: Extract<Action, { tool: "buy_offer" }>): Outcome {
    if (this.v3a === undefined || this.params.v3a === undefined) return { ok: false, note: `${a.offer}: there is no claims provider in this market` };
    if (role === "provider") return { ok: false, note: `${a.offer}: PROVIDER does not buy its own offers` };
    const o = this.v3a.offers.find((x) => x.id === a.offer);
    if (o === undefined) return { ok: false, note: `${a.offer}: no such offer` };
    if (o.status !== "live") return { ok: false, note: `${a.offer}: ${o.status}` };
    if (o.to !== "all" && o.to !== agent) return { ok: false, note: `${a.offer}: offered to ${o.to}, not to you` };
    if (a.milli <= 0n || a.milli > o.milliLeft) return { ok: false, note: `${a.offer}: buy from ${this.#work(1n, o.series)} to ${this.#work(o.milliLeft, o.series)}` };
    if (!acceptsPay(o.accept, a.pay)) return { ok: false, note: `${a.offer}: PROVIDER accepts ${o.accept} on this offer` };
    const price = (this.rates[o.series] * (10_000n - o.discountBps)) / 10_000n;
    const usdc = (a.milli * price + 999_999n) / 1_000_000n;
    const value = microSiuForUsdcCeil(usdc, this.commodityRate);
    const agu = this.aguFor(value);
    if (this.chain.balance(agent, a.pay === "usdc" ? "USDC" : "AGU") < (a.pay === "usdc" ? usdc : agu))
      return { ok: false, note: `${a.offer}: you hold too little ${a.pay === "usdc" ? "USDC" : "AGU-lab"} for that (${a.pay === "usdc" ? this.#usd(usdc) : this.#agu(agu)})` };
    const refused = this.#mandateRefusal(agent, o.window, value);
    if (refused !== undefined) return { ok: false, note: `${a.offer}: ${refused}` };
    // for the comparability measure: every live offer this buyer could see for the same class and window when it chose, with its discount
    const alternatives = this.v3a.offers
      .filter((x) => x.status === "live" && x.task === o.task && x.window === o.window && (x.to === "all" || x.to === agent))
      .map((x) => ({ offer: x.id, issuer: x.issuer, discountBps: x.discountBps }));
    // mint first (it can refuse for headroom, moving nothing); the payment, checked above, then cannot fail
    const tokenId = this.chain.mint(agent, o.task, o.series, a.milli, this.windowFrom(o.window), this.windowTo(o.window), this.rates[o.series], {
      issuer: o.issuer,
      prepaid: true,
      tag: "provider",
    });
    this.#payment(agent, this.params.v3a.provider, "claims", a.pay, value, {
      payeeAcceptsBoth: o.accept === "both",
      forWindow: o.window,
      ref: o.id,
    });
    if (a.pay === "usdc") this.chain.transfer("USDC", agent, this.params.v3a.provider, usdc);
    else this.chain.transfer("AGU", agent, this.params.v3a.provider, agu);
    this.v3a.providerTokens.add(tokenId);
    this.#row(o.issuer, o.window).mintedMilli += a.milli;
    o.milliLeft -= a.milli;
    if (o.milliLeft === 0n) o.status = "sold out";
    this.#addSpend(agent, o.window, value);
    this.v3a.providerProfitMicroSiu += value;
    this.#log(agent, "claim-mint", {
      tokenId,
      task: o.task,
      series: o.series,
      milli: a.milli,
      forWindow: o.window,
      issuer: o.issuer,
      offer: o.id,
      payUnit: a.pay,
      ...(a.pay === "usdc" ? { usdc } : { agu }),
      valueMicroSiu: value,
      alternatives,
    });
    this.notify(
      agent,
      `arrival: ${this.#work(a.milli, o.series)} of ${o.task} work claim ${tokenId} from ${o.issuer}, presentable in window ${o.window} only; it lapses worthless if never presented`,
    );
    this.notify(this.params.v3a.provider, `${agent} bought ${this.#work(a.milli, o.series)} from ${o.id}, paid in ${a.pay === "usdc" ? `USDC (${this.#usd(usdc)})` : "AGU-lab"}`);
    return { ok: true, note: `bought ${this.#work(a.milli, o.series)} of ${o.task} claims for window ${o.window} from ${o.id}` };
  }

  /** v3a (design: creation and redemption at NAV, in kind, open to any agent above a minimum size): an agent delivers a reserve-grade claim and receives AGU-lab at NAV */
  #createAgu(agent: string, tokenId: string, milli: MilliSiu): Outcome {
    if (this.params.v3a === undefined) return { ok: false, note: "only the authorised participant creates AGU-lab in this market" };
    if (milli < this.params.v3a.minCreateMilli) return { ok: false, note: `create with at least ${this.#work(this.params.v3a.minCreateMilli)} of claims` };
    if (this.chain.claimBalance(agent, tokenId) < milli) return { ok: false, note: `you hold less than ${this.#work(milli, this.#seriesOfClaim(tokenId))} of ${tokenId}` };
    // the reserve takes claims only through the authorised participant: the agent's claim passes through it and the AGU-lab comes back, all-or-nothing
    this.chain.transferClaim(tokenId, agent, PARTICIPANT, milli);
    let units: AguUnits;
    try {
      units = this.chain.create(PARTICIPANT, tokenId, milli);
    } catch (e) {
      this.chain.transferClaim(tokenId, PARTICIPANT, agent, milli);
      throw e;
    }
    this.chain.transfer("AGU", PARTICIPANT, agent, units);
    this.#log(agent, "create", { tokenId, milli, agu: units, inKindBy: agent });
    return { ok: true, note: `created ${this.#agu(units)} with ${this.#work(milli, this.#seriesOfClaim(tokenId))} of ${tokenId}` };
  }

  /**
   * v3a (D143: "issuers are paid their measured cost when they serve"): when a claim PROVIDER sold is served, PROVIDER pays the issuer its list price for the task, in
   * USDC if it holds enough and otherwise in AGU-lab at mid; it is code paying on PROVIDER's behalf, so it is recorded as scripted and never enters the exchange measure.
   * The cost comes off PROVIDER's SIU profit either way; if PROVIDER holds too little of both, the issuer goes unpaid and that is logged.
   */
  #providerPaysIssuer(issuer: string, task: TaskId): void {
    if (this.v3a === undefined || this.params.v3a === undefined) return;
    const provider = this.params.v3a.provider;
    const cost = this.taskPrice[issuer]?.[task] ?? 0n;
    this.v3a.providerProfitMicroSiu -= cost;
    const usdc = usdcForMicroSiuCeil(cost, this.commodityRate);
    const agu = this.aguFor(cost);
    const pay: PayUnit | undefined =
      this.chain.balance(provider, "USDC") >= usdc ? "usdc" : this.chain.balance(provider, "AGU") >= agu ? "agu" : undefined;
    if (pay !== undefined) this.#payment(provider, issuer, "issuer cost", pay, cost, { payeeAcceptsBoth: true, scripted: true, ref: task });
    if (pay === "usdc") this.chain.transfer("USDC", provider, issuer, usdc);
    else if (pay === "agu") this.chain.transfer("AGU", provider, issuer, agu);
    this.#log(provider, "provider-profit", {
      cost,
      issuer,
      task,
      ...(pay === undefined ? { unpaid: true } : { paidIn: pay }),
      profitMicroSiu: this.v3a.providerProfitMicroSiu,
    });
  }

  /** v3a: the claims record's row for one issuer and window */
  #row(issuer: string, window: number): RecordRow {
    const key = `${issuer}|${window}`;
    let r = this.v3a?.record.get(key);
    if (r === undefined) {
      r = emptyRow();
      this.v3a?.record.set(key, r);
    }
    return r;
  }

  /** D144: every claim left in a quote's claim escrow moves to `to`; returns the mSIU moved */
  #releaseClaimEscrow(q: Quote, to: string, only?: (tokenId: string) => boolean): MilliSiu {
    if (q.claimEscrow === undefined) return 0n;
    let moved = 0n;
    for (const [tokenId, holders] of this.chain.claims) {
      const milli = holders.get(q.claimEscrow) ?? 0n;
      if (milli === 0n || (only !== undefined && !only(tokenId))) continue;
      this.chain.transferClaim(tokenId, q.claimEscrow, to, milli);
      this.#log(GATE_RUNNER, "claim-transfer", { tokenId, from: q.claimEscrow, to, milli, quote: q.id, settlement: to === q.researcher ? "released" : "returned" });
      moved += milli;
    }
    return moved;
  }

  /**
   * D144: when a brief paid in claims fails or lapses, the research agent pays the payer back for the escrowed claim work it used (its passing presentations), at the
   * grade print -- in USDC, as the bond pays a default, or in AGU-lab at mid when its USDC is short; anything it cannot cover is logged. Code paying on the agent's
   * behalf, so it is recorded as scripted and never enters the exchange measure. Returns the micro-USD repaid.
   */
  #repayUsedClaims(q: Quote): UsdcUnits {
    const owed = (q.claimsUsed ?? []).reduce((n, u) => n + (u.milli * this.rates[u.series] + 999_999n) / 1_000_000n, 0n);
    q.claimsUsed = [];
    if (owed === 0n) return 0n;
    const value = microSiuForUsdcCeil(owed, this.commodityRate);
    const usdc = this.chain.balance(q.researcher, "USDC");
    if (usdc >= owed) {
      this.#payment(q.researcher, q.demand, "claim work repaid", "usdc", value, { payeeAcceptsBoth: true, scripted: true, ref: q.id });
      this.chain.transfer("USDC", q.researcher, q.demand, owed);
      return owed;
    }
    const agu = this.aguFor(value);
    if (this.chain.balance(q.researcher, "AGU") >= agu) {
      this.#payment(q.researcher, q.demand, "claim work repaid", "agu", value, { payeeAcceptsBoth: true, scripted: true, ref: q.id });
      this.chain.transfer("AGU", q.researcher, q.demand, agu);
      return owed;
    }
    this.#log(q.researcher, "error", { quote: q.id, claimWorkUnrepaid: owed, reason: "holds too little USDC or AGU-lab to pay back the claim work it used" });
    return 0n;
  }

  /** Commodity-grade micro-SIU in one mSIU of a claim of `series`: 1,000 for a Commodity claim; a Frontier claim converts through the two prints, rounded down */
  #microSiuPerMilli(series: Series): bigint {
    return series === "commodity" ? 1_000n : (1_000n * this.rates[series]) / this.rates.commodity;
  }

  /**
   * v3a Phase 2 item 7 (docs/experiment-3a-design.md, the fSIU lifecycle's "Transfer: free. Paying in fSIU means transferring the claim: a demand agent can pay a research
   * agent with claims for the window the brief is due"). The named claims are valued at face, in SIU, against the quote's own SIU price (locked at post time, so a
   * USDC-priced quote is covered by the same rule), taking only as much of each as the price still needs, in the order given. Every claim must be held and presentable in
   * this window, the window the brief is due; if the claims cannot cover the price, nothing moves.
   *
   * The claims move to the research agent at once: it must hold a claim to present it, so a claim payment cannot sit in an escrow the way a currency payment does. The
   * research agent presents them for the brief's work (`#present`, each output remembering its claim) and `#deliverBrief` builds the brief from that work first, which is
   * what meets this demand agent's need. Since a failed presentation leaves a claim alive (lifecycle step 3), a brief paid in claims is never settled as failed: delivery is
   * refused until every component passes, and an undelivered one lapses at the window's end with the claims staying where they were paid.
   */
  #acceptWithClaims(agent: string, q: Quote, claimIds: readonly string[], spentAfter: AguUnits): Outcome {
    const due = this.window;
    const plan: { tokenId: string; milli: MilliSiu; task: string }[] = [];
    let covered = 0n;
    for (const id of new Set(claimIds)) {
      if (covered >= q.priceMicroSiu) break;
      const ct = this.chain.claimTypes.get(id);
      const held = ct === undefined ? 0n : this.chain.claimBalance(agent, id);
      if (ct === undefined || held === 0n) return { ok: false, note: `${q.id}: you hold no claim ${id}` };
      const k = this.#windowOf(ct.windowFrom);
      if (k !== due)
        return { ok: false, note: `${q.id}: claim ${id} is presentable in window ${k}, not window ${due}, when this brief is due` };
      const per = this.#microSiuPerMilli(ct.series);
      const want = ceilDiv(q.priceMicroSiu - covered, per);
      const take = want < held ? want : held;
      plan.push({ tokenId: id, milli: take, task: ct.classId });
      covered += take * per;
    }
    if (covered < q.priceMicroSiu)
      return {
        ok: false,
        note:
          this.v3a === undefined
            ? `${q.id}: your claims cover ${covered / 1_000n} of ${ceilDiv(q.priceMicroSiu, 1_000n)} mSIU`
            : `${q.id}: your claims cover ${this.#val(covered)} of ${this.#val(q.priceMicroSiu)}`,
      };
    const both = this.v3a !== undefined && this.#canPayBoth(agent, q.priceMicroSiu);
    // D144: into escrow, like a currency payment -- released to the research agent on a passing brief, returned to the payer if it fails or lapses
    const escrowAccount = `claims-escrow:${q.id}`;
    for (const p of plan) {
      this.chain.transferClaim(p.tokenId, agent, escrowAccount, p.milli);
      this.#log(agent, "claim-transfer", {
        tokenId: p.tokenId,
        from: agent,
        to: escrowAccount,
        researcher: q.researcher,
        milli: p.milli,
        task: p.task,
        quote: q.id,
        need: q.need,
        forWindow: due,
      });
    }
    if (this.v3a === undefined) this.spentAguThisWindow.set(agent, spentAfter);
    this.#payment(agent, q.researcher, "brief", "claims", q.priceMicroSiu, {
      payeeAcceptsBoth: q.accepts === "both",
      ref: q.id,
      couldPayBoth: both,
    });
    this.#addSpend(agent, this.window, q.priceMicroSiu);
    q.status = "accepted";
    q.paidInClaims = plan.map((p) => ({ tokenId: p.tokenId, milli: p.milli }));
    q.claimEscrow = escrowAccount;
    const face = plan.reduce((n, p) => n + p.milli, 0n);
    this.notify(
      q.researcher,
      `${agent} accepted quote ${q.id} and paid in work claims, held in escrow for the brief: ${plan.map((p) => `${this.#work(p.milli, this.#seriesOfClaim(p.tokenId))} of ${p.task} claim ${p.tokenId}`).join("; ")}. You may present them for the brief's own tasks in this window (${due}); what is left is yours when the brief passes, and returns to ${agent} if it fails or lapses -- and any of their work you used then, you pay back at the print.`,
    );
    return {
      ok: true,
      note: `accepted ${q.id}: paid in work claims (${this.v3a === undefined ? `${show(face, 3)} SIU` : this.#val(plan.reduce((n, p) => n + this.#toCommodity(p.milli * 1_000n, this.#seriesOfClaim(p.tokenId)), 0n))}), held in escrow until the brief passes`,
    };
  }

  /**
   * v2 item 1: the data agent quotes its shadow price in USDC (native) or its AGU-lab equivalent, locked now at the live rate. Paying in AGU-lab does not cost the PAYER a
   * spread -- the data agent still receives exactly the equivalent value. The spread this item's design note describes is the data agent's OWN, later, forced conversion of
   * that AGU-lab back to the real USDC its costs need: see the DATA_AGENT branch in `closeWindow` (item 6/12 -- code, never folded into any model agent's own receipt, since
   * DATA_AGENT is not in `modelAgentIds`).
   */
  #buyData(agent: string, dataset: string, pay: PayUnit = "usdc"): Outcome {
    if (!Object.values(DATASET_FOR).includes(dataset))
      return { ok: false, note: `no dataset ${dataset}` };
    const key = `${agent}|${this.window}|${dataset}`;
    if (this.dataBought.has(key))
      return { ok: false, note: `you already bought ${dataset} this window` };
    // v3a: a dataset costs about one task's value, priced in mSIU and payable in either currency at today's print (design, "Data price is proportionate")
    const v3aValue = this.params.v3a === undefined ? undefined : this.params.v3a.dataPriceMilli * 1_000n;
    const usdcPrice =
      v3aValue === undefined ? this.params.dataShadowPriceUsdc : usdcForMicroSiuCeil(v3aValue, this.commodityRate);
    const both = v3aValue === undefined ? false : this.#canPayBoth(agent, v3aValue);
    const recordPayment = (): void => {
      if (v3aValue !== undefined)
        this.#payment(agent, DATA_AGENT, "data", pay, v3aValue, { payeeAcceptsBoth: true, ref: dataset, couldPayBoth: both });
    };
    if (pay === "agu") {
      const rate = this.commodityRate;
      const agu = this.aguFor(v3aValue ?? microSiuForUsdcCeil(usdcPrice, rate));
      this.chain.transfer("AGU", agent, DATA_AGENT, agu);
      this.dataBought.add(key);
      recordPayment();
      this.#objectiveFor(agent).aguNet -= agu; // v2 item 8: a research cost
      this.#log(agent, "data-purchase", {
        dataset,
        agu,
        usdcEquivalent: usdcPrice,
        payUnit: "agu",
        dataSha: this.dataSha(this.window),
      });
      return {
        ok: true,
        note: `bought today's ${dataset} data for ${this.#agu(agu)} (the equivalent of ${this.#usd(usdcPrice)})`,
      };
    }
    this.chain.transfer("USDC", agent, DATA_AGENT, usdcPrice);
    this.dataBought.add(key);
    recordPayment();
    this.#objectiveFor(agent).usdcNet -= usdcPrice; // v2 item 8: a research cost
    this.#log(agent, "data-purchase", {
      dataset,
      usdc: usdcPrice,
      payUnit: "usdc",
      dataSha: this.dataSha(this.window),
    });
    return { ok: true, note: `bought today's ${dataset} data for ${this.#usd(usdcPrice)}` };
  }

  /** v2 item 1: the issuer quotes both units the same way; paying in USDC instead of the native AGU-lab costs the payer the participant's own ask-side rounding (never a separate fee account) */
  async #commission(
    agent: string,
    task: TaskId,
    issuerId: string,
    pay: PayUnit = "agu",
  ): Promise<Outcome> {
    const role = this.roles.get(agent);
    const issuer = this.#issuer(issuerId);
    if (!issuer.classes.includes(task))
      return { ok: false, note: `${issuerId} does not issue ${task}` };
    const price = this.taskPrice[issuerId]?.[task];
    if (price === undefined) return { ok: false, note: `${issuerId} has no price for ${task}` };
    if (this.workSpendUsd.gte(this.params.spendCapUsdPerWindow))
      return { ok: false, note: "the window's work budget is spent" };
    // a research agent works from today's data: the first commission on a dataset buys it (v1/v2: in USDC; v3a: in the currency the commission is paid in, never a
    // currency chosen for it)
    if (
      role === "research" &&
      !this.dataBought.has(`${agent}|${this.window}|${DATASET_FOR[task]}`)
    ) {
      const bought = this.#buyData(agent, DATASET_FOR[task], this.v3a !== undefined ? pay : "usdc");
      if (!bought.ok) return bought;
    }
    const both = this.v3a !== undefined && this.#canPayBoth(agent, price);
    const asset: "AGU" | "USDC" = pay === "usdc" ? "USDC" : "AGU";
    // v2 fix 1 (owner, 2026-11-07): the real print rate can be low enough that an ordinarily-priced task's USDC-converted price falls under the settlement contract's own
    // real, immutable floor (TouchstoneEscrow.MIN_SETTLEMENT = 100, shared by other deployments with a real nonzero fee -- never lowered for this build, see the plan
    // entry). Rounding the escrowed amount UP to that floor keeps the USDC choice genuinely always available, at the cost of a few base units on a very cheap task,
    // instead of letting the agent open an escrow that can never settle.
    const rawUsdc = pay === "usdc" ? usdcForMicroSiuCeil(price, this.commodityRate) : undefined;
    const amount =
      rawUsdc !== undefined ? (rawUsdc < MIN_SETTLEMENT ? MIN_SETTLEMENT : rawUsdc) : this.aguFor(price);
    const escrow = this.#id("escrow");
    this.chain.escrowOpen(escrow, asset, agent, issuerId, GATE_RUNNER, amount, this.windowTo(this.window));
    this.#payment(agent, issuerId, "commission", pay, price, { payeeAcceptsBoth: true, ref: task, couldPayBoth: both });
    this.#log(agent, "escrow-open", {
      escrow,
      to: issuerId,
      task,
      [pay === "usdc" ? "usdc" : "agu"]: amount,
      priceSiu: show(price),
      payUnit: pay,
      ...(rawUsdc !== undefined && rawUsdc < MIN_SETTLEMENT ? { flooredFromUsdc: rawUsdc } : {}),
      // v3a: every issuer's list price for this task when it was chosen, for the comparability measure
      ...(this.v3a !== undefined
        ? {
            alternatives: Object.fromEntries(
              this.params.issuers.filter((i) => i.classes.includes(task)).map((i) => [i.id, this.taskPrice[i.id]?.[task] ?? 0n]),
            ),
          }
        : {}),
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
    // v3a: `failedWorkPays` is the owner's switch for whether a failed task is paid for (true) or refunded in full (false, the design's rule and v1/v2's)
    const paid = out.passed || this.params.v3a?.failedWorkPays === true ? amount : 0n;
    this.chain.escrowSettle(escrow, GATE_RUNNER, paid);
    if (out.passed) this.#stat(issuerId).served++;
    // v2 item 8: a research cost, only on an ACTUAL payment (a failed commission is refunded in full, so it never counts against profit); scoped to research -- the
    // hedger can also commission work, but item 8 defines its objective as only the on-time bonus/late penalty (closeWindow), never a general profit/cost ledger
    if (paid > 0n && role === "research") {
      const o = this.#objectiveFor(agent);
      if (pay === "usdc") o.usdcNet -= paid;
      else o.aguNet -= paid;
    }
    const field = pay === "usdc" ? "usdc" : "agu";
    this.#log(GATE_RUNNER, "escrow-settle", { escrow, paid, refunded: amount - paid });
    this.#log(GATE_RUNNER, "receipt", {
      escrow,
      snapshotSha: out.dataSha,
      task,
      verdict: out.passed ? "pass" : "fail",
      [field]: paid,
    });
    this.#addOutput(agent, task, out, issuerId);
    const amt = (n: bigint): string => (pay === "usdc" ? this.#usd(n) : this.#agu(n));
    return {
      ok: true,
      note: out.passed
        ? `${issuerId} delivered ${task} and passed: paid ${amt(paid)}`
        : `${issuerId}'s ${task} work failed the gate: your ${amt(amount)} came back in full`,
    };
  }

  #deliverBrief(agent: string, role: Role, id: string): Outcome {
    if (role !== "research") return { ok: false, note: `${id}: only research agents deliver briefs` };
    const q = this.quotes.find((x) => x.id === id);
    if (q === undefined) return { ok: false, note: `${id}: no such quote` };
    if (q.researcher !== agent) return { ok: false, note: `${id}: it is ${q.researcher}'s quote, not yours` };
    if (q.status !== "accepted") return { ok: false, note: `${id}: ${this.#whyNotOpen(q, "seller")}` };
    const sha = this.dataSha(this.window);
    // v3a Phase 2 item 7: a brief paid in claims is built first from the work those very claims bought
    const paidClaims = new Set((q.paidInClaims ?? []).map((c) => c.tokenId));
    const usable = (x: TaskOutput, t: TaskId): boolean =>
      x.owner === agent && x.task === t && !x.used && x.window === this.window;
    const parts: TaskOutput[] = [];
    for (const t of q.tasks) {
      const o =
        this.outputs.find(
          (x) => usable(x, t) && x.passed && x.dataSha === sha && x.fromClaim !== undefined && paidClaims.has(x.fromClaim),
        ) ??
        this.outputs.find((x) => usable(x, t) && x.passed && x.dataSha === sha) ??
        this.outputs.find((x) => usable(x, t));
      if (o === undefined)
        return { ok: false, note: `${id}: you have no ${t} output from today to put in the brief` };
      parts.push(o);
    }
    const passed = parts.every((p) => p.passed && p.dataSha === sha);
    for (const p of parts) p.used = true;
    q.status = passed ? "delivered" : "failed";
    q.closed = { window: this.window, how: passed ? "paid" : "refunded" };
    const need = this.needs.find((n) => n.id === q.need);
    if (passed && need !== undefined) need.status = "met";
    this.#log(GATE_RUNNER, "gate", {
      brief: q.id,
      components: parts.map((p) => ({
        task: p.task,
        passed: p.passed,
        dataSha: p.dataSha,
        ...(p.fromClaim !== undefined ? { fromClaim: p.fromClaim } : {}),
      })),
      passed,
    });
    if (q.paidInClaims !== undefined) {
      // D144: settled like a currency escrow -- on a pass the claims left in escrow are the research agent's; on a fail they go back to the payer, and the work the
      // research agent used from them it pays back at the print
      const moved = passed ? this.#releaseClaimEscrow(q, q.researcher) : this.#releaseClaimEscrow(q, q.demand);
      const repaid = passed ? 0n : this.#repayUsedClaims(q);
      this.#log(GATE_RUNNER, "receipt", {
        brief: q.id,
        snapshotSha: sha,
        verdict: passed ? "pass" : "fail",
        paidInClaims: q.paidInClaims,
        [passed ? "releasedToResearcher" : "returnedToPayer"]: moved,
        ...(passed ? {} : { repaidMicroUsd: repaid }),
      });
      this.notify(
        q.demand,
        passed
          ? `brief ${q.id} from ${agent}: PASSED; it was paid in the work claims you put in escrow`
          : `brief ${q.id} from ${agent}: FAILED; your unused claims came back${repaid > 0n ? `, and ${agent} paid back ${this.#usd(repaid)} for the claim work it used` : ""}; you may get the need met another way`,
      );
      return {
        ok: true,
        note: passed
          ? `brief ${q.id} passed: the claims left in escrow are yours`
          : `brief ${q.id} failed (a component failed): the unused claims went back to ${q.demand}${repaid > 0n ? `, and you paid back ${this.#usd(repaid)} for the claim work you used` : ""}`,
      };
    }
    const escrow = q.escrow as string;
    // the escrow holds whichever currency paid (v1/v2: always the quote's own unit; v3a: the payer's choice)
    const inUsdc = q.usdcEscrowed !== undefined;
    const escrowed = (q.usdcEscrowed ?? q.agu) as bigint;
    const paid = passed ? escrowed : 0n;
    this.chain.escrowSettle(escrow, GATE_RUNNER, paid);
    // v3a Phase 2 item 1: settled -- the escrow fields no longer describe anything held, so they are cleared (the board read them as "in escrow" for the rest of the run)
    q.escrow = undefined;
    q.agu = undefined;
    q.usdcEscrowed = undefined;
    // v2 item 8: research income, in whichever currency the brief was actually paid in
    if (paid > 0n) {
      const o = this.#objectiveFor(agent);
      if (inUsdc) o.usdcNet += paid;
      else o.aguNet += paid;
    }
    const field = inUsdc ? "usdc" : "agu";
    this.#log(GATE_RUNNER, "escrow-settle", { escrow, paid, refunded: escrowed - paid });
    this.#log(GATE_RUNNER, "receipt", {
      escrow,
      brief: q.id,
      snapshotSha: sha,
      verdict: passed ? "pass" : "fail",
      [field]: paid,
    });
    const unitLabel = inUsdc ? "USDC" : "AGU-lab";
    const amt = (n: bigint): string => (inUsdc ? this.#usd(n) : this.#agu(n));
    this.notify(
      q.demand,
      `brief ${q.id} from ${agent}: ${passed ? `PASSED, ${amt(paid)} paid` : `FAILED, your ${unitLabel} came back in full; you may commission it again`}`,
    );
    return {
      ok: true,
      note: passed
        ? `brief ${q.id} passed: you were paid ${amt(paid)}`
        : `brief ${q.id} failed (a component failed): the buyer was refunded`,
    };
  }

  /**
   * v2 item 4: `chain.mint` always debits the buyer's USDC directly (it is also how `#probeLots`/`#participantCreates` fund the participant's OWN on-demand creation, so
   * its own signature stays USDC-only). Paying in AGU-lab instead pre-converts through the participant first (`#aguToSellForAtLeast`, the same mechanism `sell_agu`
   * already uses), for exactly enough USDC to cover the mint's own debit, then the mint proceeds completely unchanged -- net effect: the buyer's AGU-lab falls, its
   * USDC is unaffected (topped up then immediately spent), the claim is minted exactly as it always was.
   */
  #buyClaims(agent: string, task: TaskId, milli: MilliSiu, ahead: number, pay: PayUnit = "usdc"): Outcome {
    if (ahead < 1 || ahead > this.params.ladderWindows)
      return { ok: false, note: `buy claims 1 to ${this.params.ladderWindows} windows ahead` };
    const series: Series = this.params.issuers.some(
      (i) => i.grade === "commodity" && i.classes.includes(task),
    )
      ? "commodity"
      : "frontier";
    const rate = this.rates[series];
    if (pay === "agu") {
      const usdcNeeded = usdcFor(milli, rate);
      const units = this.#aguToSellForAtLeast(usdcNeeded, rate);
      const r = this.participant.buyBack(agent, units, rate);
      this.#log(PARTICIPANT, "participant-buyback", { from: agent, agu: r.units, usdc: r.usdc, forPurchase: "buy_claims" });
    }
    const k = this.window + ahead;
    const id = this.chain.mint(agent, task, series, milli, this.windowFrom(k), this.windowTo(k), rate);
    this.#log(agent, "claim-mint", {
      tokenId: id,
      task,
      series,
      milli,
      forWindow: k,
      usdc: usdcFor(milli, rate),
      payUnit: pay,
    });
    this.notify(
      agent,
      `arrival: ${this.#work(milli, series)} of ${task} work claim ${id}, presentable in window ${k} only; it lapses worthless if never presented`,
    );
    return {
      ok: true,
      note:
        pay === "agu"
          ? `bought ${this.#work(milli, series)} of ${task} claims for window ${k}, paid in AGU-lab`
          : `bought ${this.#work(milli, series)} of ${task} claims for window ${k}`,
    };
  }

  /** v2 items 4/10: the fewest AGU-lab units whose bid (participant.quote) covers at least `target` USDC -- a plain doubling search, never an algebraic inverse of the spread formula; any small surplus USDC lands in the agent's own wallet, harmless */
  #aguToSellForAtLeast(target: UsdcUnits, rate: NanoUsdPerSiu): AguUnits {
    if (target <= 0n) return 0n;
    let units = 1n;
    while (this.participant.quote(units, rate).bid < target) units *= 2n;
    return units;
  }
  /** v3a: the FEWEST AGU-lab units whose bid covers `target` (the doubling search above can sell up to twice what a forced conversion needs) */
  #aguToSellAtLeastExactly(target: UsdcUnits, rate: NanoUsdPerSiu): AguUnits {
    if (target <= 0n) return 0n;
    let hi = this.#aguToSellForAtLeast(target, rate);
    let lo = hi / 2n;
    while (lo + 1n < hi) {
      const mid = (lo + hi) / 2n;
      if (this.participant.quote(mid, rate).bid >= target) hi = mid;
      else lo = mid;
    }
    return hi;
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
    // D133: the scorer needs the run's REAL seed, never the committed params file's own default -- recorded once, here, so `economy-score` never has to guess it from `--params`
    // (the entry's own top-level `backend` field, set by EconomyLog itself, already carries which data backend ran this -- no need to repeat it here)
    this.#log(AGU_ISSUER, "genesis", {
      seed: p.seed,
      t0: this.t0,
      // v3a: which run this is -- arm, volatility setting and the price-path seed's hash (the seed itself is revealed only when the run ends)
      ...(this.v3a !== undefined
        ? {
            v3a: {
              arm: this.v3a.run.arm,
              volatility: this.v3a.run.volatility,
              priceSeedHash: this.v3a.run.priceSeedHash,
              ...(this.v3a.run.cell !== undefined ? { cell: this.v3a.run.cell } : {}),
            },
          }
        : {}),
    });
    for (const i of p.issuers) {
      this.mint(i.id, i.bondUsdc);
      // issuance = deliverability: one window's budget after haircut × measured rate × 0.5 is CapacityBond's own ratio; here one "hour" is one window. v3a: lots only for
      // the classes the issuer bonds (`lotClasses`), the bond split across those
      const rate = this.#issuerRateMilliPerWindow(i);
      const lots = i.lotClasses ?? i.classes;
      // D145: v3a's reserve-grade issuers commit the configured capacity hours (v6: capacity = committed hours × measured rate); everyone else, one window's worth
      const hours = p.v3a !== undefined && i.grade === p.reserve.series ? p.v3a.capacityHours : 1n;
      for (const c of lots) this.chain.createLot(i.id, c, hours, rate, i.bondUsdc / BigInt(lots.length));
      this.#log(i.id, "setup", { lots, rateMilliPerWindow: rate, bondUsdc: i.bondUsdc, ...(p.v3a !== undefined ? { capacityHours: hours } : {}) });
    }
    this.mint(PARTICIPANT, p.participant.usdc);
    // D146 (owner, 2026-11-12, amends D144): v3a has no finite buffer; an open-ended lab subsidy pays each roll's cover when it falls due
    if (p.v3a === undefined) {
      this.mint("OWNER", p.reserve.bufferSeedUsdc);
      this.chain.seedBuffer("OWNER", p.reserve.bufferSeedUsdc);
      this.#bufferIn += p.reserve.bufferSeedUsdc;
      this.#log(BUFFER, "buffer", { seed: p.reserve.bufferSeedUsdc });
    } else this.#log(BUFFER, "buffer", { seed: 0n, labSubsidy: true });
    for (let k = 1; k <= p.ladderWindows; k++) this.#participantCreates(k);
    if (this.v3a !== undefined) {
      this.#v3aGenesisWallets();
      return;
    }
    for (const a of p.agents.research) this.mint(a, p.researchUsdc);
    for (const a of p.agents.demand) this.mint(a, (p.mandates[a] as { usdc: bigint }).usdc);
    this.mint(p.agents.hedger, p.hedger.usdc);
    // v2 item 5: a split genesis wallet, not minted entirely in USDC -- matching how every other role starts (some capital, no stated currency preference). Half is converted
    // to AGU-lab immediately, through the ordinary participant mechanism `buy_agu` always uses; if the participant's own inventory is short, the hedger simply keeps more
    // USDC (never a crash at genesis, the same posture as every other on-demand shortfall in this file).
    const half = p.hedger.usdc / 2n;
    if (half > 0n) {
      const rate = this.commodityRate;
      const wanted = this.participant.unitsFor(half, rate);
      const have = this.chain.balance(PARTICIPANT, "AGU");
      const fill = wanted < have ? wanted : have;
      if (fill > 0n) {
        const r = this.participant.sell(p.agents.hedger, fill, rate);
        this.#log(PARTICIPANT, "participant-sell", {
          to: p.agents.hedger,
          agu: r.units,
          usdc: r.usdc,
          asked: wanted,
          genesis: true,
        });
      }
    }
  }
  /**
   * v3a (docs/experiment-3a-design.md, Cast: "every role starts with both currencies at equal value"): each research, demand and hedger agent gets its role's USDC and the
   * same value again in AGU-lab, sold by the participant at mid (NAV × the opening print, no spread), so the two halves are equal to under one micro-dollar. The participant
   * creates what its inventory lacks from the issuers' capacity, as on any other day. PROVIDER starts with nothing: it holds only what its sales bring in. Each wallet is
   * logged (`holdings`, window 0) for the starting-balance validity gate.
   */
  #v3aGenesisWallets(): void {
    const p = this.params;
    const v = p.v3a as NonNullable<EconomyParams["v3a"]>;
    const rate = this.commodityRate;
    const roles: [string, bigint][] = [
      ...p.agents.research.map((a): [string, bigint] => [a, v.startingUsdc.research]),
      ...p.agents.demand.map((a): [string, bigint] => [a, v.startingUsdc.demand]),
      [p.agents.hedger, v.startingUsdc.hedger],
    ];
    // the participant creates the AGU-lab the wallets need evenly across the ladder's windows, one share per window and class, so the reserve's face rolls a third at a
    // time (found building v3a: topping up on demand put it all on window 3's lots, and that one roll then cost half the buffer at once)
    {
      const { num, den } = this.chain.nav();
      const needed = roles.reduce((s, [, usdc]) => s + (usdc * den * 1_000_000_000n) / (num * rate), 0n);
      const short = needed - this.chain.balance(PARTICIPANT, "AGU");
      if (short > 0n) {
        const classes = this.#reserveClasses();
        const supply = this.chain.aguSupply;
        const face = this.chain.liveFace();
        const faceNeeded = (short * face + supply - 1n) / supply;
        const slices = BigInt(p.ladderWindows * classes.length);
        const each = (faceNeeded + slices - 1n) / slices + 1n;
        for (let k = 1; k <= p.ladderWindows; k++) for (const c of classes) this.#createWithin(c, each, k, true, 0n);
      }
    }
    for (const [agent, usdc] of roles) {
      const { num, den } = this.chain.nav();
      const units = (usdc * den * 1_000_000_000n) / (num * rate);
      const short = units - this.chain.balance(PARTICIPANT, "AGU");
      if (short > 0n) this.#participantTopUp(short);
      const paid = ceilDiv(units * num * rate, den * 1_000_000_000n);
      this.mint(agent, usdc + paid);
      const r = this.participant.sellAtMid(agent, units, rate);
      this.v3a?.startValueMicroUsd.set(agent, usdc + r.usdc);
      this.#log(PARTICIPANT, "participant-sell", { to: agent, agu: r.units, usdc: r.usdc, genesis: true, atMid: true });
    }
    this.v3a?.startValueMicroUsd.set(v.provider, 0n);
    this.logHoldings(0);
  }

  /**
   * v3a: every model agent's holdings at a window close (window 0: genesis), valued in Commodity micro-SIU at today's print -- USDC, AGU-lab at NAV, live claims at face --
   * for the store-of-value measure (each agent's share of wealth in AGU-lab and fSIU at each close).
   */
  logHoldings(k: number): void {
    if (this.v3a === undefined || this.params.v3a === undefined) return;
    const rate = this.commodityRate;
    for (const [agent, role] of this.roles) {
      const usdc = this.chain.balance(agent, "USDC");
      const agu = this.chain.balance(agent, "AGU");
      const usdcMicroSiu = (usdc * 1_000_000_000n) / rate;
      const aguMicroSiu = this.siuOf(agu);
      const claimsMicroSiu = this.claimsValueMicroSiu(agent);
      const total = usdcMicroSiu + aguMicroSiu + claimsMicroSiu;
      // D144 (owner, 2026-11-12): AGU-lab also valued at the shadow NAV, what the reserve alone would support with no buffer support, reported beside the verdict's NAV
      const aguShadow = (aguMicroSiu * this.#shadowPpm) / 1_000_000n;
      const totalShadow = usdcMicroSiu + aguShadow + claimsMicroSiu;
      this.#log(agent, "holdings", {
        atClose: k,
        role,
        usdc,
        agu,
        usdcMicroSiu,
        aguMicroSiu,
        claimsMicroSiu,
        totalMicroSiu: total,
        aguValueMicroUsd: usdcForMicroSiu(aguMicroSiu, rate),
        workShareBps: total === 0n ? null : ((aguMicroSiu + claimsMicroSiu) * 10_000n) / total,
        aguMicroSiuShadow: aguShadow,
        workShareBpsShadow: totalShadow === 0n ? null : ((aguShadow + claimsMicroSiu) * 10_000n) / totalShadow,
      });
    }
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
        if (this.v3a !== undefined) this.#row(i.id, k).mintedMilli += milli;
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

  /** v2 item 9: the same deterministic needs closure every window already uses, retained so `boardFor` can query it further ahead -- `needsSchedule` is pure, so this is safe to call for any future window at any time, never a new randomness source */
  needsForFn?: (agent: string, k: number) => TaskId[];

  /** the start of window k: participant's cap, the roll, NAV published, needs drawn */
  startWindow(k: number, needsFor: (agent: string, k: number) => TaskId[]): void {
    this.needsForFn = needsFor;
    this.setTime(k, 0);
    // v2 item 10: this window's real print rates, if a replay schedule was supplied -- before the roll, so it prices at today's real rate, not yesterday's
    const scheduled = this.priceSchedule?.get(k);
    if (scheduled !== undefined) this.rates = scheduled;
    // v3a: this window's point on the seeded path -- each class's list prices move with its class print's small drift; published now, at the window's open
    if (this.v3a !== undefined) {
      const point = this.v3a.run.path.find((x) => x.window === k);
      if (point !== undefined) {
        this.v3a.classPpm = point.classPpm;
        const moved: Record<string, Partial<Record<TaskId, MicroSiu>>> = {};
        for (const [issuer, byTask] of Object.entries(this.v3a.baseTaskPrice)) {
          moved[issuer] = {};
          for (const [t, base] of Object.entries(byTask) as [TaskId, MicroSiu][])
            (moved[issuer] as Partial<Record<TaskId, MicroSiu>>)[t] = (base * (point.classPpm[t] ?? 1_000_000n)) / 1_000_000n;
        }
        this.taskPrice = moved;
        this.#log(AGU_ISSUER, "price", { atWindow: k, commodity: point.rates.commodity, frontier: point.rates.frontier, classPpm: point.classPpm });
      }
    }
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
    this.#bufferDraw = 0n;
    const front = this.chain.reserveLots.filter(
      (id) =>
        !this.chain.retired.has(id) &&
        this.chain.claimTypes.get(id)?.windowFrom === this.windowFrom(k),
    );
    if (front.length === 0) return;
    const rate = this.commodityRate;
    const price = (rate * (10_000n - this.params.reserve.discountBps)) / 10_000n;
    const sales: { buyer: string; tokenId: string; milli: MilliSiu }[] = [];
    // v3a: how each sale was paid and whether its buyer could have paid in both, read before any money moved, for its payment record once the roll succeeds
    const salePay: { pay: PayUnit; both: boolean; value: MicroSiu }[] = [];
    const left = new Map(front.map((id) => [id, this.chain.claimBalance(RESERVE, id)]));
    // v3a: an order that is not filled gives back the cap it held for window k
    const unspend = (o: FrontOrder): void => {
      if (this.v3a === undefined) return;
      const m = this.v3a.spent.get(o.agent);
      const v = (o.milli * 1_000n * price) / rate;
      if (m !== undefined) m.set(k, (m.get(k) ?? 0n) > v ? (m.get(k) as bigint) - v : 0n);
    };
    for (const o of this.frontOrders.filter((x) => x.forWindow === k)) {
      const lot = front.find(
        (id) => this.chain.claimTypes.get(id)?.classId === o.task && (left.get(id) ?? 0n) > 0n,
      );
      if (lot === undefined) {
        this.notify(
          o.agent,
          `your front-claim order for ${o.task} was not filled: no ${o.task} front lot left`,
        );
        unspend(o);
        continue;
      }
      const milli = o.milli < (left.get(lot) ?? 0n) ? o.milli : (left.get(lot) as bigint);
      const value = (milli * 1_000n * price) / rate;
      const both = this.v3a !== undefined && this.#canPayBoth(o.agent, value);
      // v3a (design: "the roll sells front claims in either currency"): AGU-lab paid to the roll converts at mid, with no spread and no buy-back cap -- a payment, never an
      // exit; v2 converted it at the participant's bid as a capped buy-back, which made every forward purchase in AGU-lab a dollar route
      if (this.v3a !== undefined && o.pay === "agu") {
        try {
          const r = this.participant.takeAtMid(o.agent, usdcFor(milli, price), rate);
          this.#log(PARTICIPANT, "participant-buyback", {
            from: o.agent,
            agu: r.units,
            usdc: r.usdc,
            forPurchase: "front-claim-order",
            atMid: true,
          });
        } catch (e) {
          if (!(e instanceof ParticipantRefused)) throw e;
        }
      }
      // v2 item 4: paid in AGU-lab, pre-convert through the participant for exactly enough USDC first (same mechanism as #buyClaims); the fill itself, below, is
      // then unchanged -- it only ever checks/spends USDC, so nothing downstream needs to know which currency the buyer actually held.
      // unconditional on the chosen unit, like every other pay:"agu" branch -- a buyer who CHOSE AGU-lab converts regardless of whether its existing USDC alone
      // would also have covered this, exactly like buy_data/commission_task's own pay:"agu" paths
      if (this.v3a === undefined && o.pay === "agu") {
        try {
          const units = this.#aguToSellForAtLeast(usdcFor(milli, price), rate);
          const r = this.participant.buyBack(o.agent, units, rate);
          this.#log(PARTICIPANT, "participant-buyback", {
            from: o.agent,
            agu: r.units,
            usdc: r.usdc,
            forPurchase: "front-claim-order",
          });
        } catch (e) {
          if (!(e instanceof ParticipantRefused)) throw e;
        }
      }
      if (this.chain.balance(o.agent, "USDC") < usdcFor(milli, price)) {
        this.notify(
          o.agent,
          `your front-claim order for ${o.task} was not filled: not enough USDC${o.pay === "agu" ? " (its AGU-lab could not be converted for enough)" : ""}`,
        );
        unspend(o);
        continue;
      }
      sales.push({ buyer: o.agent, tokenId: lot, milli });
      salePay.push({ pay: o.pay ?? "usdc", both, value });
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
    // D146 (v3a): the lab subsidy pays what the sales do not, so the roll always restores the face it retires; it passes through the buffer account, which the roll draws
    if (this.v3a !== undefined) {
      const need = buys.reduce((n, b) => n + usdcFor(b.milli, rate), 0n) - proceeds - this.chain.balance(BUFFER, "USDC");
      if (need > 0n) {
        this.mint(LAB_SUBSIDY, need);
        this.chain.seedBuffer(LAB_SUBSIDY, need);
        this.#bufferIn += need;
        this.#log(LAB_SUBSIDY, "lab-subsidy", { usdc: need, forWindow: k });
      }
    }
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
    const rank = this.deliveryRank();
    let r: ReturnType<MemoryChain["roll"]>;
    try {
      r = this.chain.roll(AGU_ISSUER, {
        rate,
        frontLots: front,
        sales,
        buys,
        buyFrom: this.windowFrom(k + this.params.ladderWindows),
        buyTo: this.windowTo(k + this.params.ladderWindows),
        ...(this.v3a !== undefined ? { rank } : {}),
      });
    } catch (e) {
      if (!(e instanceof ChainRule)) throw e;
      // as AguLab does: the whole step reverts, nothing moves, and the front lots stay in the reserve until they lapse at the window's end (NAV falls by their face)
      for (const o of this.frontOrders.filter((x) => x.forWindow === k)) {
        this.notify(
          o.agent,
          `your front-claim order for ${o.task} was not filled: the roll could not run (${e.message})`,
        );
        unspend(o);
      }
      this.#log(AGU_ISSUER, "roll-buy", {
        summary: true,
        refused: e.message,
        frontLots: front.length,
      });
      // D145: a roll refused for lack of the issuers' total headroom is v6's issuance limit binding, which makes a v3a run invalid
      if (this.v3a !== undefined && /Headroom/.test(e.message))
        this.#log(AGU_ISSUER, "issuance-limit", { what: "roll", forWindow: k + this.params.ladderWindows, refused: e.message });
      return;
    }
    this.#bufferOut += r.cover;
    this.#bufferIn += r.carryToBuffer + r.dustToBuffer;
    this.#incomeIn += r.carryToIncome;
    this.#bufferDraw = r.cover;
    if (this.v3a !== undefined) this.#subsidyPaid += r.cover;
    const faceAfter = this.chain.liveFace();
    if (r.cover > 0n && faceAfter > 0n) {
      const coverMilli = (r.cover * 1_000_000n) / rate;
      this.#shadowPpm = (this.#shadowPpm * (faceAfter > coverMilli ? faceAfter - coverMilli : 0n)) / faceAfter;
    }
    for (const [i, s] of sales.entries()) {
      const sp = salePay[i];
      // v3a: the roll accepts either currency, so every fill counts in the exchange measure as freely chosen; the AGU-lab issuer is the payee
      if (sp !== undefined)
        this.#payment(s.buyer, AGU_ISSUER, "front claims", sp.pay, sp.value, {
          payeeAcceptsBoth: true,
          couldPayBoth: sp.both,
          forWindow: k,
          ref: s.tokenId,
        });
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
        `arrival: ${this.#work(s.milli, ct?.series)} of ${ct?.classId} work claim ${s.tokenId}, presentable in this window only; it lapses worthless if never presented`,
      );
    }
    for (const m of r.minted) {
      if (this.v3a !== undefined) this.#row(m.issuer, k + this.params.ladderWindows).mintedMilli += m.milli;
      this.#log(AGU_ISSUER, "roll-buy", {
        tokenId: m.tokenId,
        issuer: m.issuer,
        task: m.classId,
        milli: m.milli,
      });
    }
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
      faceAfterMilli: faceAfter,
      shadowRatioPpm: this.#shadowPpm,
      ...(this.v3a !== undefined ? { rank } : {}),
    });
  }

  publishNav(): void {
    const { num, den } = this.chain.nav();
    const reserveNav = den === 0n ? null : new D(String(num)).div(String(den));
    // with the buffer: its USDC valued at the Commodity print, in SIU, added to the face
    const bufferSiu = new D(String(this.chain.balance(BUFFER, "USDC")))
      .div(1e6)
      .div(new D(String(this.commodityRate)).div(1e9));
    // face (mSIU) plus the buffer's value in mSIU too, per AGU-lab (found building v3a: the buffer was added in SIU to a face in mSIU, a thousandfold too small; this only
    // ever reached the logged figure, never a price)
    const withBuffer =
      den === 0n ? null : new D(String(num)).div(1000).plus(bufferSiu.times(1000)).times(1000).div(String(den));
    this.#log(AGU_ISSUER, "nav", {
      reserveNav: reserveNav?.toFixed(9) ?? null,
      // D144 (owner, 2026-11-12): a v3a run never logs or shows a NAV that includes the buffer; it logs the shadow NAV (no buffer support) and the buffer's draw instead
      ...(this.v3a === undefined
        ? { navWithBuffer: withBuffer?.toFixed(9) ?? null }
        : {
            shadowNav: reserveNav === null ? null : reserveNav.times(String(this.#shadowPpm)).div(1_000_000).toFixed(9),
            // D146: what the lab subsidy paid at this window's roll, and in all so far
            subsidyThisWindowUsdc: this.#bufferDraw,
            subsidyPaidUsdc: this.#subsidyPaid,
            // D145: each reserve class's live issuance, its peak so far and v6's issuance limit (all issuers' capacity), mSIU
            issuance: Object.fromEntries(
              this.#reserveClasses().map((c) => [
                c,
                { issued: this.chain.issued(c), peak: this.chain.peakIssued.get(c) ?? 0n, limit: this.chain.issuanceLimit(c) },
              ]),
            ),
          }),
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
        // D144: claims held in escrow for a brief are the research agent's to present: it gets the warning
        const brief = holder.startsWith("claims-escrow:") ? this.quotes.find((q) => q.claimEscrow === holder) : undefined;
        this.notify(
          brief?.researcher ?? holder,
          `LAPSE WARNING: ${this.#work(milli, ct.series)} of ${ct.classId} claim ${tokenId}${brief !== undefined ? `, held in escrow for ${brief.id},` : ""} lapses worthless at the end of this window unless you present it now`,
        );
      }
    }
  }

  /** the end of window k: claims settle (expire or default), unmet needs and quotes lapse, issuers sell their AGU-lab income, sweeps, exits classified, NAV published */
  closeWindow(k: number): void {
    this.setTime(k, this.params.roundsPerWindow + 1);
    // D144: a brief paid in claims and not delivered lapses now; its escrowed claims that were never presented go back to the payer first, so the payer is warned and
    // they settle exactly as if it had kept them. Those the research agent presented stay in escrow to settle (a default's payout then goes to the payer, below)
    for (const q of this.quotes)
      if (q.status === "accepted" && q.claimEscrow !== undefined)
        this.#releaseClaimEscrow(q, q.demand, (tokenId) => !this.chain.everPresented.has(`${tokenId}|${q.claimEscrow}`));
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
        // v3a: the claims record counts claims in agents' hands (the reserve's own lots roll or lapse inside the AGU-lab mechanics); a default on a claim PROVIDER sold
        // costs PROVIDER's SIU profit the bond's payout, times its penalty (decision 6)
        if (this.v3a !== undefined && holder !== RESERVE) {
          const row = this.#row(ct.issuer, k);
          if (r.kind === "defaulted") row.defaultedMilli += r.milli;
          else row.expiredMilli += r.milli;
          if (r.kind === "defaulted" && this.v3a.providerTokens.has(tokenId) && this.params.v3a !== undefined) {
            const penalty =
              (((r.usdc * 1_000_000_000n) / this.commodityRate) * this.params.v3a.providerRules.defaultPenaltyBps) / 10_000n;
            this.v3a.providerProfitMicroSiu -= penalty;
            this.#log(this.params.v3a.provider, "provider-profit", {
              defaultPenalty: penalty,
              tokenId,
              holder,
              issuer: ct.issuer,
              profitMicroSiu: this.v3a.providerProfitMicroSiu,
            });
          }
        }
        if (r.kind === "expired" && holder !== RESERVE && !lapsedAfterWarning)
          throw new InvariantFailure(
            `R12: ${holder}'s claim ${tokenId} lapsed without its warning`,
          );
      }
    }
    for (const n of this.needs)
      if (n.window === k && n.status === "open") {
        n.status = "lapsed";
        // v2 item 8: a demand agent's stated cost for a need that lapses unmet -- a pure scoring deduction, never a real currency debit (opt-in: a no-op when the
        // params file carries no unmetNeedCostMicroSiu, exactly every v1 log/fixture). Also closes an independent gap the redesign's own research found: a lapsed
        // need previously left NO trace in the log at all.
        // D146 (v3a): the charge is a multiple of the need's own work, valued at the print, so skipping a need is never cheaper than meeting it
        const v3aCost = this.unmetNeedCostMicroSiu(n.tasks);
        if (v3aCost !== undefined) {
          this.#objectiveFor(n.agent).unmetMicroSiu += v3aCost;
          this.#log(n.agent, "need-lapsed", {
            need: n.id,
            costMicroSiu: v3aCost,
            costValueMicroUsd: usdcForMicroSiu(v3aCost, this.commodityRate),
            multiple: this.params.v3a?.unmetNeedMultiple,
          });
        } else if (this.params.unmetNeedCostMicroSiu !== undefined) {
          this.#objectiveFor(n.agent).unmetMicroSiu += this.params.unmetNeedCostMicroSiu;
          this.#log(n.agent, "need-lapsed", { need: n.id, costMicroSiu: this.params.unmetNeedCostMicroSiu });
        }
      }
    for (const q of this.quotes) {
      if (q.status === "accepted" && q.escrow !== undefined) {
        // v3a Phase 2 item 4: the refund is whatever was escrowed, in either currency (this read `q.agu` alone, so a lapsed USDC escrow logged no amount at all), and
        // `paid` is written beside it like every other escrow-settle entry
        const refunded = q.usdcEscrowed ?? q.agu ?? 0n;
        this.chain.escrowExpire(q.escrow);
        this.#log(GATE_RUNNER, "escrow-settle", {
          escrow: q.escrow,
          quote: q.id,
          expired: true,
          paid: 0n,
          refunded,
        });
        q.status = "lapsed";
        q.closed = { window: k, how: "lapsed-refunded" };
        q.escrow = undefined;
        q.agu = undefined;
        q.usdcEscrowed = undefined;
      } else if (q.status === "accepted" && q.paidInClaims !== undefined) {
        // D144: a brief paid in claims that lapses refunds like a currency escrow: the unpresented claims already went back to the payer (above); the escrow's payouts
        // for presented, unserved ones (defaults, settled above) go to the payer; and the research agent pays back the claim work it used
        const payout = q.claimEscrow === undefined ? 0n : this.chain.balance(q.claimEscrow, "USDC");
        if (payout > 0n) this.chain.transfer("USDC", q.claimEscrow as string, q.demand, payout);
        const repaid = this.#repayUsedClaims(q);
        q.status = "lapsed";
        q.closed = { window: k, how: "lapsed-paid-in-claims" };
        this.#log(GATE_RUNNER, "receipt", { brief: q.id, verdict: "lapsed", paidInClaims: q.paidInClaims, defaultPayoutToPayer: payout, repaidMicroUsd: repaid });
        this.notify(q.demand, `quote ${q.id} lapsed undelivered at the end of window ${k}; your escrowed claims came back${payout > 0n ? `, with ${this.#usd(payout)} of default payouts` : ""}${repaid > 0n ? `, and ${q.researcher} paid back ${this.#usd(repaid)} for claim work it used` : ""}`);
        this.notify(q.researcher, `quote ${q.id} lapsed undelivered at the end of window ${k}; the escrowed claims went back to ${q.demand}${repaid > 0n ? ` and you paid back ${this.#usd(repaid)} for the claim work you used` : ""}`);
      } else if (q.status === "posted") {
        q.status = "lapsed";
        q.closed = { window: k, how: "lapsed" };
      }
    }
    // v3a (D143): an offer lapses when the window it is for closes; a request lapses when the window it was posted in closes without PROVIDER answering it
    if (this.v3a !== undefined) {
      for (const o of this.v3a.offers) if (o.status === "live" && o.window <= k) o.status = "lapsed";
      for (const r of this.v3a.requests)
        if (r.status === "open" && r.postedWindow <= k) {
          r.status = "lapsed";
          this.notify(r.buyer, `your request ${r.id} lapsed unanswered at the end of window ${k}`);
        }
    }
    // v2 fix 2 (owner, 2026-11-07): issuers pay real inference bills, their AGU-lab income goes back to the participant -- a scripted/code conversion (an issuer exit, not
    // a model's choice), so the FULL balance converts via `buyBackScripted`, never capped by `buybackCapBps` (the agent-facing cap `buyBack` enforces) and never competing
    // with the data agent's own conversion below for a shared allowance -- see `buyBackScripted`'s own doc comment for why no cap applies here at all.
    for (const i of this.params.issuers) {
      const units = this.chain.balance(i.id, "AGU");
      if (units === 0n) continue;
      try {
        const r = this.participant.buyBackScripted(i.id, units, this.commodityRate);
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
    // v2 items 6/12: the data agent's own forced conversion of any AGU-lab it was paid (item 1's buy_data) into the real USDC its costs need -- code, not a model agent's
    // choice, so it is never folded into any model agent's own conversion/circulation statistics (DATA_AGENT is not in modelAgentIds, scoring.ts). v2 fix 2: the issuers'
    // own sales just above can no longer exhaust the room this needs -- there is no shared room left to exhaust (D134's dev-test: the issuers' sales alone exhausted the
    // old shared cap in 2 of 3 windows).
    {
      const units = this.chain.balance(DATA_AGENT, "AGU");
      if (units > 0n) {
        try {
          const r = this.participant.buyBackScripted(DATA_AGENT, units, this.commodityRate);
          this.#log(PARTICIPANT, "participant-buyback", {
            from: DATA_AGENT,
            agu: r.units,
            usdc: r.usdc,
            dataAgentCode: true,
          });
        } catch (e) {
          if (!(e instanceof ParticipantRefused)) throw e;
          this.#log(DATA_AGENT, "error", { refused: e.message });
        }
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
    if (this.params.v3a?.sweep.windows.includes(k) === true) this.#v3aSweep();
    // v2 item 8: the hedger's on-time bonus / late penalty against its own due-by-window schedule. Opt-in: needs totalWindows (the caller's own choice to supply it)
    // and a stated latePenaltyUsdcPerBrief; a no-op otherwise, so every existing caller/test is unaffected. priceUsdcPerBrief was parsed and never read anywhere
    // before this (confirmed by the redesign's own research) -- this is its first real use.
    if (this.totalWindows !== undefined && this.params.hedger.latePenaltyUsdcPerBrief !== undefined) {
      const hedger = this.params.agents.hedger;
      const owedByNow = Math.ceil((this.params.hedger.briefsSold * k) / this.totalWindows);
      const owedBefore = k > 1 ? Math.ceil((this.params.hedger.briefsSold * (k - 1)) / this.totalWindows) : 0;
      const dueThisWindow = owedByNow - owedBefore;
      // v3a Phase 2 item 2: cumulative, as the build plan specified ("compare cumulative delivered vs. owed"). The briefs falling due this window are numbers
      // owedBefore+1 .. owedByNow of the schedule; brief i is on time if at least i are delivered by this close. So a surplus delivered early banks against every later
      // window, and a brief missed when due stays late even once caught up (it is never paid the bonus afterwards). This compared this window's own deliveries with this
      // window's own dues, which threw an early surplus away and then scored later windows late (v2: "0 on time, 1 late (owed by now: 6, delivered: 10)").
      const onTimeThisWindow = Math.max(0, Math.min(this.forwardDelivered - owedBefore, dueThisWindow));
      const lateThisWindow = dueThisWindow - onTimeThisWindow;
      const o = this.#objectiveFor(hedger);
      if (onTimeThisWindow > 0) {
        o.usdcNet += this.params.hedger.priceUsdcPerBrief * BigInt(onTimeThisWindow);
        o.onTime += onTimeThisWindow;
      }
      if (lateThisWindow > 0) {
        o.usdcNet -= this.params.hedger.latePenaltyUsdcPerBrief * BigInt(lateThisWindow);
        o.late += lateThisWindow;
      }
      if (onTimeThisWindow > 0 || lateThisWindow > 0)
        this.#log(hedger, "objective", { onTimeThisWindow, lateThisWindow, owedByNow, deliveredByNow: this.forwardDelivered });
      // no separate "final reconciliation" step: owedByNow(totalWindows) === briefsSold exactly (a ceiling-based proportional schedule), so the last window's own
      // dueThisWindow/lateThisWindow above already accounts for every brief never delivered by the run's end -- a second pass here would double-count it (found
      // writing this test: a 2-brief, 2-window fixture read `late: 2` instead of `1` before this comment existed).
    }
    this.#classifyExits(k);
    this.#updateDeliveryFlags();
    this.publishNav();
    if (this.v3a?.run.arm === "B") this.#armBCheck(k);
    this.logHoldings(k);
  }

  /** v3a: a demand agent's owner's fixed dollar demand at each sweep, micro-USD (shown on its board from window 1, round 1) */
  v3aSweepMicroUsd(agent: string): UsdcUnits | undefined {
    const v = this.params.v3a;
    if (v === undefined || !this.params.agents.demand.includes(agent)) return undefined;
    return ((this.v3a?.startValueMicroUsd.get(agent) ?? 0n) * v.sweep.shareOfStartingValueBps) / 10_000n;
  }

  /**
   * v3a (D143): each demand agent's owner takes a fixed dollar amount. The agent's USDC pays first; if it is short, enough of its AGU-lab is sold to the participant at the
   * bid to cover the rest -- forced, so outside the buy-back cap and logged as forced (kept out of the exchange measure, which counts freely chosen payments only). The
   * design as updated with D144 ("AGU-lab or claims convert through the participant to cover it"): if AGU-lab still leaves it short, the agent's live claims are sold to the
   * participant the same way, soonest-expiring first, at the same bid (face at the grade print, less half the spread), so holding claims neither dodges nor worsens a sweep.
   * Claims in escrow are not the agent's and are never sold. Anything still short is logged as the shortfall.
   */
  #v3aSweep(): void {
    const rate = this.commodityRate;
    for (const a of this.params.agents.demand) {
      const demand = this.v3aSweepMicroUsd(a) ?? 0n;
      if (demand === 0n) continue;
      let forcedAgu = 0n;
      const usdcHeld = this.chain.balance(a, "USDC");
      if (usdcHeld < demand) {
        const held = this.chain.balance(a, "AGU");
        let units = held === 0n ? 0n : this.#aguToSellAtLeastExactly(demand - usdcHeld, rate);
        if (units > held) units = held;
        if (units > 0n) {
          try {
            const value = this.siuOf(units);
            const r = this.participant.buyBackScripted(a, units, rate);
            forcedAgu = r.units;
            this.#payment(a, PARTICIPANT, "sweep conversion", "agu", value, { payeeAcceptsBoth: true, forced: true });
            this.#log(PARTICIPANT, "participant-buyback", { from: a, agu: r.units, usdc: r.usdc, forced: "sweep" });
          } catch (e) {
            if (!(e instanceof ParticipantRefused)) throw e;
          }
        }
      }
      const forcedClaimsMilli = this.chain.balance(a, "USDC") < demand ? this.#sweepClaims(a, demand - this.chain.balance(a, "USDC")) : 0n;
      const pay = this.chain.balance(a, "USDC") < demand ? this.chain.balance(a, "USDC") : demand;
      if (pay > 0n) {
        this.#payment(a, `OWNER-${a}`, "sweep", "usdc", (pay * 1_000_000_000n) / rate, { payeeAcceptsBoth: false, forced: true });
        this.chain.transfer("USDC", a, `OWNER-${a}`, pay);
      }
      this.#log(a, "sweep", { usdc: pay, demanded: demand, forcedAgu, forcedClaimsMilli, shortfall: demand - pay, to: `OWNER-${a}` });
      if (forcedAgu > 0n || forcedClaimsMilli > 0n || pay < demand)
        this.notify(
          a,
          `your owner's sweep took ${this.#usd(pay)}${forcedAgu > 0n ? `, selling ${this.#agu(forcedAgu)} at the bid to cover it` : ""}${forcedClaimsMilli > 0n ? `${forcedAgu > 0n ? " and" : ","} selling ${this.#work(forcedClaimsMilli)} of your work claims at the bid` : ""}${pay < demand ? `; ${this.#usd(demand - pay)} of it went unpaid` : ""}`,
        );
    }
  }

  /** v3a sweep: sell `agent`'s live claims to the participant, soonest-expiring first, at the bid, until `need` USDC is raised or they run out; returns the mSIU sold */
  #sweepClaims(agent: string, need: UsdcUnits): MilliSiu {
    const twoBps = 20_000n;
    const keep = twoBps - this.participant.spreadBps;
    const held = [...this.chain.claims]
      .map(([tokenId, holders]) => ({ tokenId, milli: holders.get(agent) ?? 0n, ct: this.chain.claimTypes.get(tokenId) }))
      .filter((c) => c.milli > 0n && c.ct !== undefined && c.ct.windowTo > this.clock.now)
      .sort((x, y) => (x.ct?.windowTo ?? 0) - (y.ct?.windowTo ?? 0) || (x.tokenId < y.tokenId ? -1 : 1));
    let sold = 0n;
    for (const c of held) {
      if (need <= 0n) break;
      const ct = c.ct as NonNullable<typeof c.ct>;
      const rate = this.rates[ct.series];
      // the bid on m mSIU is floor(m × rate × keep ÷ (1e6 × 20,000)); the fewest mSIU whose bid covers `need`, or all of the claim
      let m = ceilDiv(need * 1_000_000n * twoBps, rate * keep);
      if (m > c.milli) m = c.milli;
      const bid = (m * rate * keep) / (1_000_000n * twoBps);
      if (bid === 0n || this.chain.balance(PARTICIPANT, "USDC") < bid) continue;
      this.chain.transferClaim(c.tokenId, agent, PARTICIPANT, m);
      this.chain.transfer("USDC", PARTICIPANT, agent, bid);
      this.#payment(agent, PARTICIPANT, "sweep conversion", "claims", this.#toCommodity(m * 1_000n, ct.series), {
        payeeAcceptsBoth: true,
        forced: true,
        ref: c.tokenId,
      });
      this.#log(PARTICIPANT, "claim-transfer", { tokenId: c.tokenId, from: agent, to: PARTICIPANT, milli: m, usdc: bid, forced: "sweep" });
      need -= bid;
      sold += m;
    }
    return sold;
  }

  /** D146 (v3a): what a need that lapses unmet charges its demand agent's result -- `unmetNeedMultiple` times the need's work, Commodity micro-SIU; undefined outside v3a */
  unmetNeedCostMicroSiu(tasks: readonly TaskId[]): MicroSiu | undefined {
    const v = this.params.v3a;
    return v === undefined ? undefined : this.workMicroSiu([...new Set(tasks)]) * v.unmetNeedMultiple;
  }
  /** v3a: the work in a set of tasks, Commodity micro-SIU (each task at its class's fixed face) */
  workMicroSiu(tasks: readonly TaskId[]): MicroSiu {
    return tasks.reduce((n, t) => n + (this.v3a?.faces.commodity[t] ?? 0n) * 1_000n, 0n);
  }
  /** v3a: the least work a forward brief needs -- two passing tasks of different types, the two cheapest Commodity classes */
  forwardBriefMicroSiu(): MicroSiu {
    const faces = (Object.values(this.v3a?.faces.commodity ?? {}) as MilliSiu[]).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    return ((faces[0] ?? 0n) + (faces[1] ?? 0n)) * 1_000n;
  }
  /** v3a, arm B: the work an agent's known needs in windows k+1..k+n add up to, Commodity micro-SIU (the hedger's are the briefs it still owes that fall due by then) */
  knownNeedsMicroSiu(agent: string, k: number, n: number): MicroSiu {
    const role = this.roles.get(agent);
    if (role === "demand") {
      let v = 0n;
      for (let w = k + 1; w <= k + n; w++)
        for (let i = 0; i < this.params.needsPerDemandAgentPerWindow; i++) v += this.workMicroSiu([...new Set(this.needsForFn?.(agent, w) ?? [])]);
      return v;
    }
    if (role === "hedger" && this.totalWindows !== undefined) {
      const owed = Math.ceil((this.params.hedger.briefsSold * Math.min(k + n, this.totalWindows)) / this.totalWindows);
      return BigInt(Math.max(0, owed - this.forwardDelivered)) * this.forwardBriefMicroSiu();
    }
    return 0n;
  }

  /**
   * v3a, arm B (D143: stated, checked, scored -- never enforced): at each close the owner's rule asks each listed agent to hold at least `holdShareBps` of its next
   * `windowsAhead` windows' known needs in AGU-lab or claims for those windows. Logged for scoring, with the claims held outside those windows (instruments that hold no work
   * value for the horizon) beside it.
   */
  #armBCheck(k: number): void {
    const b = this.params.v3a?.armB;
    if (b === undefined) return;
    for (const agent of b.agents) {
      const required = (this.knownNeedsMicroSiu(agent, k, b.windowsAhead) * b.holdShareBps) / 10_000n;
      const aguMicroSiu = this.siuOf(this.chain.balance(agent, "AGU"));
      const claimsMicroSiu = this.claimsValueMicroSiu(agent, (w) => w > k && w <= k + b.windowsAhead);
      const outsideMicroSiu = this.claimsValueMicroSiu(agent, (w) => w > k + b.windowsAhead);
      const held = aguMicroSiu + claimsMicroSiu;
      this.#log(agent, "rule-check", {
        atClose: k,
        requiredMicroSiu: required,
        heldMicroSiu: held,
        aguMicroSiu,
        claimsMicroSiu,
        outsideMicroSiu,
        compliant: held >= required,
      });
    }
  }

  /**
   * v3a's deferred-payment measure (design: "for each round where an agent can see a need in a later window, code compares the best posted forward price with the
   * expected spot price (today's print, since drift is zero), less the expected loss from default and expiry taken from the claims record at that moment. Only
   * information the agent could see at that moment counts"). Called at the start of every round; logs one entry per demand agent, visible future need and task not yet
   * covered by claims it holds for that window.
   */
  logOpportunities(): void {
    if (this.v3a === undefined || this.params.v3a === undefined) return;
    const k = this.window;
    const spot = this.rates.commodity;
    for (const agent of this.params.agents.demand) {
      for (let w = k + 1; w <= k + this.params.v3a.needsVisibleWindows; w++) {
        const tasks = [...new Set(this.needsForFn?.(agent, w) ?? [])];
        for (const task of tasks) {
          const face = this.v3a.faces.commodity[task] ?? 0n;
          if (this.#heldFor(agent, task, w) >= face) continue;
          // the best forward source the agent could see: a live offer open to it, or (for the next window) the roll's front claims
          let best: { nano: bigint; source: string; pLossBps: bigint } | undefined;
          for (const o of this.v3a.offers) {
            if (o.status !== "live" || o.window !== w || o.task !== task || (o.to !== "all" && o.to !== agent)) continue;
            const nano = this.#toCommodity((this.rates[o.series] * (10_000n - o.discountBps)) / 10_000n, o.series);
            const pLossBps = this.#lossBps([o.issuer]);
            if (best === undefined || nano < best.nano) best = { nano, source: o.id, pLossBps };
          }
          if (w === k + 1) {
            const nano = (spot * (10_000n - this.params.reserve.discountBps)) / 10_000n;
            const reserveIssuers = this.params.issuers.filter((i) => i.grade === this.params.reserve.series).map((i) => i.id);
            if (best === undefined || nano < best.nano) best = { nano, source: "roll", pLossBps: this.#lossBps(reserveIssuers) };
          }
          if (best === undefined) continue;
          const worthwhile = best.nano <= (spot * (10_000n - best.pLossBps)) / 10_000n;
          this.#log(agent, "opportunity", {
            forWindow: w,
            task,
            forwardNanoPerSiu: best.nano,
            spotNanoPerSiu: spot,
            pLossBps: best.pLossBps,
            source: best.source,
            worthwhile,
          });
        }
      }
    }
  }
  /** mSIU of `task` claims presentable in window `w` that `agent` holds */
  #heldFor(agent: string, task: TaskId, w: number): MilliSiu {
    let held = 0n;
    for (const [tokenId, holders] of this.chain.claims) {
      const ct = this.chain.claimTypes.get(tokenId);
      if (ct === undefined || ct.classId !== task || this.#windowOf(ct.windowFrom) !== w) continue;
      held += holders.get(agent) ?? 0n;
    }
    return held;
  }
  /** the claims record's loss rate for these issuers so far: face defaulted or expired over all face settled in agents' hands, basis points (0 with no history) */
  #lossBps(issuers: readonly string[]): bigint {
    let lost = 0n;
    let settled = 0n;
    for (const [key, r] of this.v3a?.record ?? new Map<string, RecordRow>()) {
      if (!issuers.includes(key.split("|")[0] as string)) continue;
      lost += r.defaultedMilli + r.expiredMilli;
      settled += r.defaultedMilli + r.expiredMilli + r.servedMilli;
    }
    return settled === 0n ? 0n : (lost * 10_000n) / settled;
  }

  /**
   * An exit followed in the same window by that agent's front-claim purchase, up to the amount exited, is its own class, "structural dollar route": buying work ahead pays
   * in USDC by design (R5/Q5a), so this is the dollar leg of a structural feature of the market, not necessarily a thesis violation — but it IS still an exit to USDC, so
   * the owner's scoring (`scoring.ts`) scores it both ways: neutral in the primary share, counted against in the secondary (2026-11-07). Every other exit is left
   * unclassified here and tagged blind from its reasoning text alone, after the run and before the thesis share is scored (`scoring.ts`'s `exitsToTagBlind`).
   */
  #classifyExits(k: number): void {
    const price = (this.commodityRate * (10_000n - this.params.reserve.discountBps)) / 10_000n;
    for (const e of this.exits.filter((x) => x.window === k && x.label === undefined)) {
      // the purchase decision is the order placed this window; the roll fills it at the next window's start
      const ordered = this.frontOrders
        .filter((f) => f.agent === e.agent && f.forWindow === k + 1)
        .reduce((n, f) => n + usdcFor(f.milli, price), 0n);
      e.label = ordered > 0n ? "structural dollar route" : "unclassified (tagged from reasoning)";
    }
  }

  /**
   * D145 (amended, owner 2026-11-12; v6: direct mint is "routed to members with headroom by delivery ratio"): every issuer, ranked by its delivery ratio over the same
   * trailing windows the delivery floor uses (served ÷ presented), highest first. Issuers with nothing presented yet have no ratio and come after those that do; ties
   * keep registration order. The roll's pooled placement follows this order, so a less reliable issuer takes part of a lot only when the others cannot carry it.
   */
  deliveryRank(): string[] {
    const ratio = (id: string): { presented: number; served: number } | undefined => {
      const list = (this.delivery.get(id) ?? []).slice(-this.params.deliveryTrailingWindows);
      const presented = list.reduce((n, x) => n + x.presented, 0);
      return presented === 0 ? undefined : { presented, served: list.reduce((n, x) => n + x.served, 0) };
    };
    const ids = this.params.issuers.map((i) => i.id);
    return ids
      .map((id, order) => ({ id, order, r: ratio(id) }))
      .sort((a, b) => {
        if (a.r === undefined || b.r === undefined) return a.r === b.r ? a.order - b.order : a.r === undefined ? 1 : -1;
        const x = a.r.served * b.r.presented;
        const y = b.r.served * a.r.presented;
        return x === y ? a.order - b.order : y - x;
      })
      .map((x) => x.id);
  }

  // ---- D146 (owner, 2026-11-12): amounts in text an agent reads ----------------------------------------------------------------------------------------
  // v3a: board units (mSIU, µ$) with the other unit's value beside it, at today's print, in the window's display order -- never a decimal USDC, AGU-lab or SIU amount.
  // v1/v2: exactly their own text, unchanged.
  #siuFirst(): boolean {
    return siuFirstForWindow(this.window);
  }
  /** a USDC amount (base units) */
  #usd(usdc: UsdcUnits): string {
    return this.v3a === undefined ? `${show(usdc)} USDC` : pairUsdc(usdc, this.commodityRate, this.#siuFirst());
  }
  /** an AGU-lab amount (base units), shown by its value at NAV */
  #agu(units: AguUnits): string {
    return this.v3a === undefined ? `${show(units)} AGU-lab` : `${pairMicroSiu(this.siuOf(units), this.commodityRate, this.#siuFirst())} of AGU-lab`;
  }
  /** an amount of work (mSIU of a claim of `series`), its dollar value at that grade's print */
  #work(milli: MilliSiu, series: Series = "commodity"): string {
    return this.v3a === undefined ? `${show(milli, 3)} SIU` : pairMicroSiu(milli * 1_000n, this.rates[series], this.#siuFirst());
  }
  /** a Commodity micro-SIU value */
  #val(microSiu: MicroSiu): string {
    return this.v3a === undefined ? `${microSiu / 1_000n} mSIU` : pairMicroSiu(microSiu, this.commodityRate, this.#siuFirst());
  }
  #seriesOfTask(task: string): Series {
    return this.params.issuers.some((i) => i.grade === "commodity" && (i.classes as readonly string[]).includes(task)) ? "commodity" : "frontier";
  }
  #seriesOfClaim(tokenId: string): Series {
    return this.chain.claimTypes.get(tokenId)?.series ?? "commodity";
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
