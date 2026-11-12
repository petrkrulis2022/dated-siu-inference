/**
 * What one agent sees on its turn: a structured board (scripted agents read it directly) and the same board as text (a model agent's prompt). Amounts are shown as plain decimals;
 * prices inside the market are in SIU, and the display order alternates between SIU first and dollars first (§16.9, the comparability measure).
 */
import { D } from "@touchstone/sdk";
import type { TaskId } from "../tasks/instances.js";
import { PARTICIPANT, RESERVE } from "./memory-chain.js";
import {
  discounted,
  microSiuForUsdcCeil,
  show,
  showMsiu,
  usdcForMicroSiu,
  type AguUnits,
  type MilliSiu,
  type UsdcUnits,
} from "./units.js";
import type { MicroSiu, Need, ObjectiveLedger, Quote, Role, TaskOutput, World } from "./world.js";
import { renderV3aBoard, v3aBoardFor, type V3aBoard } from "./board-v3a.js";

/**
 * The display order, as its own function of the window number (D75/§16.9), so every reader of a window's display order — the board itself and the pre-registered scoring
 * (`scoring.ts`) — uses the same rule. Flips every TWO windows (SIU, SIU, $, $, SIU, SIU, $, ...), not every one: tying the flip to window parity alone made it move in lock
 * step with the counted windows' own seat rotation (every window's seat also alternates by one), so every SIU-first window was Sonnet and every dollars-first window was
 * GPT-5.1 and the comparability measure could not tell the display's effect from the model's (found 2026-11-06, fixed on the owner's word 2026-11-07).
 */
export function siuFirstForWindow(k: number): boolean {
  return (k - 1) % 4 < 2;
}

/** v2 item 9: how many windows ahead a demand agent's own needs are visible -- fixed and stated here, once, per the design note */
export const FORWARD_VISIBILITY_WINDOWS = 2;

export interface ClaimHolding {
  claim: string;
  task: string;
  issuer: string;
  milli: MilliSiu;
  windowIndex: number;
  presentableNow: boolean;
}

export interface Board {
  agent: string;
  role: Role;
  window: number;
  day: string;
  round: number;
  rounds: number;
  siuFirst: boolean;
  printUsdPerSiu: string;
  reserveNav: string;
  usdc: UsdcUnits;
  agu: AguUnits;
  aguSiuValue: MicroSiu;
  askUsdcPerAgu: UsdcUnits;
  /** what the participant can sell right now (its inventory plus what the issuers' remaining capacity lets it create) */
  participantCanSell: AguUnits;
  /** every agent in the market and its role */
  agents: { id: string; role: Role }[];
  bidUsdcPerAgu: UsdcUnits;
  claims: ClaimHolding[];
  needs: Need[];
  quotes: Quote[];
  outputs: TaskOutput[];
  issuerPrices: { issuer: string; task: TaskId; priceMicroSiu: MicroSiu; skipped: boolean }[];
  dataBought: string[];
  /** v2 item 3: today's data price, in SIU terms at the live rate -- shown every round, never buried in a one-time instruction */
  dataPriceMicroSiu: MicroSiu;
  /** v2 items 3/4: the front-claim roll's own discounted price this window (per SIU of face) and its discount -- nothing economic stays prose-only */
  frontClaimPriceUsdPerSiu: string;
  frontClaimDiscountBps: bigint;
  notices: string[];
  lastResult?: string;
  mandate?: {
    spendLimitAgu: AguUnits;
    spentAgu: AguUnits;
    minUsdcBuffer: UsdcUnits;
    holdingCeilingSiu: MicroSiu;
    sweepDays: number[];
  };
  forward?: { sold: number; delivered: number };
  /** v2 item 9: this agent's own needs N windows ahead (demand and the hedger only) -- `needsSchedule` is pure, so this is never a new randomness source */
  needsAhead?: { window: number; tasks: TaskId[] }[];
  /** v2 item 8: this agent's running economic objective, both currencies tracked natively and combined only here, for display, at the live rate -- see `ObjectiveLedger`'s own doc comment in world.ts */
  objective?: {
    usdcNet: string;
    aguNet: string;
    unmetSiu: string;
    combinedUsd: string;
    /** D146: the same figures in base units (USDC, Commodity micro-SIU), for the v3a board */
    raw?: { usdcNet: bigint; aguNetMicroSiu: bigint; unmetMicroSiu: bigint; combinedUsdc: bigint };
    onTime?: number;
    late?: number;
  };
  /** v3a: the v3a board's own section (`board-v3a.ts`); present exactly when the world is a v3a world */
  v3a?: V3aBoard;
}

export function boardFor(w: World, agent: string): Board {
  const role = w.roles.get(agent) as Role;
  const notices = w.notices.get(agent) ?? [];
  w.notices.set(agent, []);
  const one = 1_000_000n;
  const q =
    w.chain.aguSupply > 0n ? w.participant.quote(one, w.commodityRate) : { ask: 0n, bid: 0n };
  const claims: ClaimHolding[] = [];
  for (const [tokenId, holders] of w.chain.claims) {
    const milli = holders.get(agent) ?? 0n;
    const ct = w.chain.claimTypes.get(tokenId);
    if (milli === 0n || ct === undefined) continue;
    claims.push({
      claim: tokenId,
      task: ct.classId,
      issuer: ct.issuer,
      milli,
      windowIndex: Math.floor((ct.windowFrom - w.t0) / w.params.secondsPerWindow),
      presentableNow: w.clock.now >= ct.windowFrom && w.clock.now < ct.windowTo,
    });
  }
  const m = w.params.mandates[agent];
  const rate = w.commodityRate;
  return {
    agent,
    role,
    window: w.window,
    day: w.dayLabel(w.window),
    round: w.round,
    rounds: w.params.roundsPerWindow,
    siuFirst: siuFirstForWindow(w.window),
    printUsdPerSiu: new D(String(rate)).div(1e9).toFixed(6),
    reserveNav: w.navText(),
    dataPriceMicroSiu: microSiuForUsdcCeil(w.params.dataShadowPriceUsdc, rate),
    frontClaimPriceUsdPerSiu: new D(String(discounted(rate, w.params.reserve.discountBps)))
      .div(1e9)
      .toFixed(6),
    frontClaimDiscountBps: w.params.reserve.discountBps,
    usdc: w.chain.balance(agent, "USDC"),
    agu: w.chain.balance(agent, "AGU"),
    aguSiuValue: w.siuOf(w.chain.balance(agent, "AGU")),
    askUsdcPerAgu: q.ask,
    participantCanSell: w.participantCanSell(),
    agents: [...w.roles].map(([id, role]) => ({ id, role })),
    bidUsdcPerAgu: q.bid,
    claims,
    needs:
      role === "demand"
        ? w.needs.filter((n) => n.agent === agent && n.window === w.window)
        : role === "research"
          ? w.needs.filter((n) => n.window === w.window && n.status === "open")
          : [],
    // v3a Phase 2 item 1: only a live quote (posted, or accepted and not yet settled) is on the board; paid, refunded and lapsed ones leave it -- a paid quote used to
    // stay for the rest of the run as "delivered, ... in escrow" (docs/v2-code-check.md item 1)
    quotes: w.quotes.filter(
      (x) => (x.demand === agent || x.researcher === agent) && (x.status === "posted" || x.status === "accepted"),
    ),
    outputs: w.outputs.filter((o) => o.owner === agent && !o.used && o.window === w.window),
    issuerPrices: w.params.issuers.flatMap((i) =>
      i.classes.map((t) => ({
        issuer: i.id,
        task: t,
        priceMicroSiu: w.taskPrice[i.id]?.[t] ?? 0n,
        skipped: w.chain.skipped.has(i.id),
      })),
    ),
    dataBought: [...w.dataBought]
      .filter((k) => k.startsWith(`${agent}|${w.window}|`))
      .map((k) => k.split("|")[2] as string),
    notices,
    ...(w.lastResult.has(agent) ? { lastResult: w.lastResult.get(agent) as string } : {}),
    ...(m !== undefined
      ? {
          mandate: {
            spendLimitAgu: m.spendLimitAguPerWindow,
            spentAgu: w.spentAguThisWindow.get(agent) ?? 0n,
            minUsdcBuffer: m.minUsdcBuffer,
            holdingCeilingSiu: w.holdingCeilingMicroSiu(agent),
            sweepDays: m.sweepDays,
          },
        }
      : {}),
    ...(role === "hedger"
      ? { forward: { sold: w.params.hedger.briefsSold, delivered: w.forwardDelivered } }
      : {}),
    // v2 item 9: forward visibility for demand agents, N windows ahead -- `needsForFn` is the SAME deterministic closure startWindow already used, queried further, no new randomness
    ...(role === "demand" && w.needsForFn !== undefined
      ? {
          needsAhead: Array.from({ length: w.params.forwardVisibilityWindows ?? FORWARD_VISIBILITY_WINDOWS }, (_, i) => {
            const k = w.window + i + 1;
            return { window: k, tasks: [...new Set(w.needsForFn?.(agent, k) ?? [])] };
          }),
        }
      : {}),
    // v2 item 8: shown once this agent's objective ledger has anything in it (lazily created on first touch, world.ts's own `#objectiveFor`)
    ...(w.objective.has(agent) ? { objective: objectiveView(w.objective.get(agent) as ObjectiveLedger, rate, w) } : {}),
    ...(w.v3a !== undefined ? { v3a: v3aBoardFor(w, agent, role) } : {}),
  };
}

/** v2 item 8: combine usdcNet/aguNet/unmetMicroSiu into one USD-equivalent figure, ONLY for display -- the ledger itself never collapses them */
function objectiveView(o: ObjectiveLedger, rate: bigint, w: World): NonNullable<Board["objective"]> {
  const aguAsMicroSiu = w.siuOf(o.aguNet);
  const combinedMicroSiu = aguAsMicroSiu - o.unmetMicroSiu;
  const combinedUsd = o.usdcNet + usdcForMicroSiu(combinedMicroSiu, rate);
  return {
    usdcNet: show(o.usdcNet),
    aguNet: show(o.aguNet),
    unmetSiu: show(o.unmetMicroSiu),
    combinedUsd: show(combinedUsd),
    // D146: the same ledger in base units, for the v3a board's own units (mSIU and µ$, never decimals)
    raw: { usdcNet: o.usdcNet, aguNetMicroSiu: aguAsMicroSiu, unmetMicroSiu: o.unmetMicroSiu, combinedUsdc: combinedUsd },
    ...(o.onTime > 0 || o.late > 0 ? { onTime: o.onTime, late: o.late } : {}),
  };
}

const usdOf = (b: Board, microSiu: MicroSiu): string =>
  new D(String(microSiu)).div(1e6).times(b.printUsdPerSiu).toFixed(6);
const price = (b: Board, microSiu: MicroSiu): string =>
  b.siuFirst
    ? `${show(microSiu)} SIU (≈ $${usdOf(b, microSiu)})`
    : `$${usdOf(b, microSiu)} (${show(microSiu)} SIU)`;
/**
 * A posted or accepted quote's own price, in whole mSIU rather than decimal SIU (the owner, 2026-11-07: "250 mSIU, not 0.25 SIU"). Scoped to quotes themselves — a research
 * agent's own freely-chosen brief price — not to the AGU wallet value, the holding ceiling or an issuer's per-task price, which stay in decimal SIU: those reflect measured
 * real costs, not a round number an agent picked. `post_quote`'s own price argument is parsed as a whole mSIU count (`parse.ts`), so this never has a remainder to drop.
 */
const quotePrice = (b: Board, microSiu: MicroSiu): string =>
  b.siuFirst
    ? `${showMsiu(microSiu)} (≈ $${usdOf(b, microSiu)})`
    : `$${usdOf(b, microSiu)} (${showMsiu(microSiu)})`;

/** the board as the text a model agent reads */
export function renderBoard(b: Board): string {
  if (b.v3a !== undefined)
    return renderV3aBoard(
      {
        agent: b.agent,
        role: b.role,
        window: b.window,
        day: b.day,
        round: b.round,
        rounds: b.rounds,
        siuFirst: b.siuFirst,
        agents: b.agents,
        needs: b.needs,
        quotes: b.quotes,
        outputs: b.outputs,
        notices: b.notices,
        ...(b.lastResult !== undefined ? { lastResult: b.lastResult } : {}),
        ...(b.objective !== undefined ? { objective: b.objective } : {}),
        ...(b.forward !== undefined ? { forward: b.forward } : {}),
      },
      b.v3a,
    );
  const lines: string[] = [];
  lines.push(
    `You are ${b.agent}, a ${b.role} agent. Day ${b.day} (window ${b.window}), round ${b.round} of ${b.rounds}.`,
  );
  lines.push(
    `Market: the Commodity CR print is $${b.printUsdPerSiu} per SIU. AGU-lab reserve NAV is ${b.reserveNav} SIU per AGU-lab. The participant sells AGU-lab at ${show(b.askUsdcPerAgu)} USDC and buys back at ${show(b.bidUsdcPerAgu)} USDC per AGU-lab.`,
  );
  lines.push(
    `Your wallet: ${show(b.usdc)} USDC; ${show(b.agu)} AGU-lab (worth ${price(b, b.aguSiuValue)}).`,
  );
  lines.push(
    `The participant can sell up to ${show(b.participantCanSell)} AGU-lab right now (the issuers' capacity this window limits what it can create).`,
  );
  lines.push(
    `Front-claim roll: order work claims for the next window at ${b.frontClaimPriceUsdPerSiu} per SIU (${(Number(b.frontClaimDiscountBps) / 100).toFixed(2)}% below the print), or buy claims further ahead at the plain print rate.`,
  );
  lines.push(
    `Agents in this market: ${b.agents.map((x) => `${x.id} (${x.role})`).join(", ")}. A message goes to one of them, or to "all".`,
  );
  if (b.mandate !== undefined)
    lines.push(
      `Your mandate: spend at most ${show(b.mandate.spendLimitAgu)} AGU-lab-equivalent value per window (spent ${show(b.mandate.spentAgu)}); keep at least ${show(b.mandate.minUsdcBuffer)} USDC; hold at most ${price(b, b.mandate.holdingCeilingSiu)} in AGU-lab; your owner sweeps your USDC on days ${b.mandate.sweepDays.join(" and ")} of the series.`,
    );
  if (b.forward !== undefined)
    lines.push(
      `You hold a standing obligation: ${b.forward.sold} briefs owed over the run, ${b.forward.delivered} delivered so far. Each needs passing outputs of two task types from the same day.`,
    );
  if (b.needsAhead !== undefined && b.needsAhead.length > 0)
    lines.push(
      `Your own needs ahead: ${b.needsAhead.map((n) => `window ${n.window}: ${n.tasks.join(" + ")}`).join("; ")}.`,
    );
  if (b.objective !== undefined) {
    const onTimeLate =
      b.objective.onTime !== undefined ? ` (${b.objective.onTime} on time, ${b.objective.late} late or missing)` : "";
    lines.push(
      `Your running result: ${b.objective.usdcNet} USDC net, ${b.objective.aguNet} AGU-lab net${b.objective.unmetSiu !== "0.000000" ? `, ${b.objective.unmetSiu} SIU charged for unmet needs` : ""} -- combined, about $${b.objective.combinedUsd}${onTimeLate}.`,
    );
  }
  if (b.claims.length > 0) {
    lines.push("Work claims you hold:");
    for (const c of b.claims)
      lines.push(
        `  - ${c.claim}: ${show(c.milli, 3)} SIU of ${c.task} work from ${c.issuer}, window ${c.windowIndex}${c.presentableNow ? " (presentable NOW; one presentation is one task)" : ""}`,
      );
  }
  if (b.needs.length > 0) {
    lines.push(
      b.role === "demand"
        ? "Your needs this window:"
        : "Open needs this window (demand agents want briefs):",
    );
    for (const n of b.needs)
      lines.push(
        `  - ${n.id} of ${n.agent}: a brief covering ${n.tasks.join(" + ")} (${n.status})`,
      );
  }
  if (b.quotes.length > 0) {
    lines.push("Quotes:");
    for (const q of b.quotes) {
      const escrowed =
        q.paidInClaims !== undefined
          ? `, paid in work claims (${show(
              q.paidInClaims.reduce((n, c) => n + c.milli, 0n),
              3,
            )} SIU, held in escrow until the brief passes)`
          : q.agu !== undefined
            ? `, ${show(q.agu)} AGU-lab in escrow`
            : q.usdcEscrowed !== undefined
              ? `, ${show(q.usdcEscrowed)} USDC in escrow`
              : "";
      const bound = q.priceUnit === "usdc" ? `${show(q.priceUsdcMicro ?? 0n)} USDC (binding)` : quotePrice(b, q.priceMicroSiu);
      lines.push(
        `  - ${q.id}: ${q.researcher} → ${q.demand}, brief on ${q.tasks.join(" + ")} for ${bound}, ${q.status}${escrowed}`,
      );
    }
  }
  if (b.outputs.length > 0) {
    lines.push("Your task outputs from today (unused):");
    for (const o of b.outputs)
      lines.push(`  - ${o.id}: ${o.task} by ${o.issuer}, ${o.passed ? "PASSED" : "FAILED"}`);
  }
  if (b.role !== "demand") {
    lines.push(
      "Issuers' prices per task (escrowed, released only on a pass; commission_task pays in AGU-lab or USDC, your choice):",
    );
    for (const p of b.issuerPrices)
      lines.push(
        `  - ${p.issuer} ${p.task}: ${price(b, p.priceMicroSiu)}${p.skipped ? " (skipped by routing: delivery below the floor)" : ""}`,
      );
  }
  if (b.role === "research")
    lines.push(
      `Data bought today: ${b.dataBought.length > 0 ? b.dataBought.join(", ") : "none"} (${price(b, b.dataPriceMicroSiu)} once per day, in USDC or AGU-lab, your choice; buy it before commissioning a task on it).`,
    );
  if (b.notices.length > 0) {
    lines.push("Since your last turn:");
    for (const n of b.notices) lines.push(`  - ${n}`);
  }
  if (b.lastResult !== undefined) lines.push(`Your last action: ${b.lastResult}`);
  return lines.join("\n");
}

/** the reserve and the participant, for the overview */
export const SYSTEM_ACCOUNTS: readonly string[] = [RESERVE, PARTICIPANT];
