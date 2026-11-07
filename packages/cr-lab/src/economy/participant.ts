/**
 * The authorised participant (`docs/part5-build-plan.md` §4.2, the owner's Q10): its own wallet and its own test USDC, funded once by its owner.
 *
 *  - It values one AGU-lab at NAV × the Commodity CR print (never a mix of grades), sells at that value plus half the spread and buys back at that value minus half the spread.
 *  - It buys back at most `buybackCapBps` of the AGU-lab supply in a window (counted against the supply at the window's start), and never beyond its own USDC: when its USDC runs out
 *    it refuses. It never draws on the reserve or the buffer, and never fills a roll shortfall.
 *  - It creates AGU-lab by delivering claims it bought from issuers with its own USDC, and sells from that inventory.
 *
 * Rounding always favours the participant by less than one base unit: the ask rounds up, the bid rounds down.
 */
import { ChainRule, PARTICIPANT, type MemoryChain } from "./memory-chain.js";
import { BPS, type AguUnits, type NanoUsdPerSiu, type UsdcUnits } from "./units.js";

const NANO = 1_000_000_000n;

export class ParticipantRefused extends Error {
  constructor(readonly rule: string) {
    super(rule);
    this.name = "ParticipantRefused";
  }
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export class Participant {
  #capBase = 0n;
  #boughtBack = 0n;
  /** v2 fix 2 (owner, 2026-11-07): tracks a scripted/code conversion's own volume for reporting only -- see `buyBackScripted`'s own doc comment for why it is never capped by `buybackCapBps`. */
  #scriptedBoughtBack = 0n;

  constructor(
    readonly chain: MemoryChain,
    readonly spreadBps: bigint,
    readonly buybackCapBps: bigint,
  ) {}

  /** called once at each window's start, before any trade */
  startWindow(): void {
    this.#capBase = this.chain.aguSupply;
    this.#boughtBack = 0n;
    this.#scriptedBoughtBack = 0n;
  }

  get boughtBackThisWindow(): AguUnits {
    return this.#boughtBack;
  }
  get capThisWindow(): AguUnits {
    return (this.#capBase * this.buybackCapBps) / BPS;
  }
  get scriptedBoughtBackThisWindow(): AguUnits {
    return this.#scriptedBoughtBack;
  }

  /** the USDC an agent pays for `units` (ask, rounded up) and receives for them (bid, rounded down), at reserve NAV × `rate` */
  quote(units: AguUnits, rate: NanoUsdPerSiu): { ask: UsdcUnits; bid: UsdcUnits } {
    const { num, den } = this.chain.nav();
    if (den === 0n || num === 0n)
      throw new ParticipantRefused("no NAV to price against: the reserve is empty");
    const base = units * num * rate;
    return {
      ask: ceilDiv(base * (2n * BPS + this.spreadBps), den * NANO * 2n * BPS),
      bid: (base * (2n * BPS - this.spreadBps)) / (den * NANO * 2n * BPS),
    };
  }

  /** how many units `usdc` buys at the ask (rounded down) */
  unitsFor(usdc: UsdcUnits, rate: NanoUsdPerSiu): AguUnits {
    const { num, den } = this.chain.nav();
    if (den === 0n || num === 0n) return 0n;
    let units = (usdc * den * NANO * 2n * BPS) / (num * rate * (2n * BPS + this.spreadBps));
    while (units > 0n && this.quote(units, rate).ask > usdc) units--;
    return units;
  }

  /** an agent buys `units` from the participant's inventory at the ask */
  sell(agent: string, units: AguUnits, rate: NanoUsdPerSiu): { units: AguUnits; usdc: UsdcUnits } {
    if (units <= 0n) throw new ParticipantRefused("nothing to sell");
    if (this.chain.balance(PARTICIPANT, "AGU") < units)
      throw new ParticipantRefused("the participant's AGU-lab inventory is short");
    const { ask } = this.quote(units, rate);
    if (this.chain.balance(agent, "USDC") < ask)
      throw new ParticipantRefused(`${agent} cannot pay the ask`);
    this.chain.transfer("USDC", agent, PARTICIPANT, ask);
    this.chain.transfer("AGU", PARTICIPANT, agent, units);
    return { units, usdc: ask };
  }

  /** an agent sells `units` back at the bid: refused beyond the window's cap or the participant's own USDC, and nothing else moves when it refuses */
  buyBack(
    agent: string,
    units: AguUnits,
    rate: NanoUsdPerSiu,
  ): { units: AguUnits; usdc: UsdcUnits } {
    if (units <= 0n) throw new ParticipantRefused("nothing to buy back");
    if (this.#boughtBack + units > this.capThisWindow)
      throw new ParticipantRefused(
        `buy-back cap: at most ${this.buybackCapBps} bps of the window's opening supply (${this.capThisWindow} units), ${this.#boughtBack} already bought back`,
      );
    const { bid } = this.quote(units, rate);
    if (this.chain.balance(PARTICIPANT, "USDC") < bid)
      throw new ParticipantRefused(
        "the participant's own USDC has run out: it refuses, and never draws on the reserve or the buffer",
      );
    try {
      this.chain.transfer("AGU", agent, PARTICIPANT, units);
    } catch (e) {
      if (e instanceof ChainRule) throw new ParticipantRefused(e.message);
      throw e;
    }
    this.chain.transfer("USDC", PARTICIPANT, agent, bid);
    this.#boughtBack += units;
    return { units, usdc: bid };
  }

  /**
   * v2 fix 2 (owner, 2026-11-07): the same trade as `buyBack`, for a SCRIPTED/code-driven conversion (an issuer's own real-inference-bill income sale, the data agent's own
   * forced conversion of AGU-lab it was paid) -- deliberately carries NO `buybackCapBps` check at all, unlike `buyBack`. That cap's whole purpose is bounding the OPEN
   * MARKET's price impact from agent speculation (`capThisWindow`'s own doc comment); a scripted conversion is not speculation, it is a structural cash-out the economy's
   * own accounting already requires (an issuer's real inference bill, the data agent's real vendor cost), so capping it by a share of AGU-lab supply was never protecting
   * against anything real for THIS kind of flow -- it was only ever an accident of sharing `buyBack`'s own allowance. That accident is exactly what D134's dev-test found:
   * the issuers' own sales exhausted the shared cap before the data agent's own conversion got a turn, in 2 of 3 windows. Dropping the cap for scripted conversions removes
   * the collision between scripted actors directly, not just between them and agents, without inventing a second cap to divide between them. The one real constraint that
   * DOES still apply -- the participant's own USDC actually being there to pay with -- is unchanged below. `scriptedBoughtBackThisWindow` still tracks the volume, for
   * reporting only.
   */
  buyBackScripted(agent: string, units: AguUnits, rate: NanoUsdPerSiu): { units: AguUnits; usdc: UsdcUnits } {
    if (units <= 0n) throw new ParticipantRefused("nothing to buy back");
    const { bid } = this.quote(units, rate);
    if (this.chain.balance(PARTICIPANT, "USDC") < bid)
      throw new ParticipantRefused(
        "the participant's own USDC has run out: it refuses, and never draws on the reserve or the buffer",
      );
    try {
      this.chain.transfer("AGU", agent, PARTICIPANT, units);
    } catch (e) {
      if (e instanceof ChainRule) throw new ParticipantRefused(e.message);
      throw e;
    }
    this.chain.transfer("USDC", PARTICIPANT, agent, bid);
    this.#scriptedBoughtBack += units;
    return { units, usdc: bid };
  }
}
