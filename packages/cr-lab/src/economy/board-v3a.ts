/**
 * The v3a board (docs/experiment-3a-design.md, "How value is established" and Cast): what each agent sees each round, beyond v2's board.
 *
 *  - Every amount in both units: work and AGU-lab in whole mSIU, dollars in whole µ$ (micro-dollars), each with its value in the other beside it; which comes first
 *    alternates with the window's display order (`siuFirst`), as v2's comparability sample requires.
 *  - The prints: the last 15, the burn-in labelled simulated; the next print is published only at each window's open.
 *  - The NAV derivation: reserve claims, expected default losses (the claims record's loss rate per issuer, applied to its live reserve face), supply, NAV in SIU and in
 *    dollars, the buffer remaining and its draw this window, and the shadow NAV the reserve alone would support without the buffer (D144: never a NAV that includes it).
 *  - The claims record per issuer and window, PROVIDER's posted offers, the agent's own requests, and every claim it holds with its window, deadline and value.
 *  - A demand agent's mandate: its cap per window of delivery and what it has committed against each, its minimum value, its owner's sweeps (amount and windows, from
 *    window 1 round 1); under arm B, the owner's holding rule and where it stands.
 */
import type { TaskId } from "../tasks/instances.js";
import { RESERVE } from "./memory-chain.js";
import { usdcForMicroSiu } from "./units.js";
import { emptyRow, type ClaimRequest, type Offer, type RecordRow } from "./v3a-market.js";
import type { MicroSiu, Role, World } from "./world.js";

export interface V3aClaimView {
  claim: string;
  task: string;
  issuer: string;
  milli: bigint;
  window: number;
  presentableNow: boolean;
  /** rounds left to present it in, when it is presentable now */
  roundsLeft?: number;
  valueMicroUsd: bigint;
  /** sold by PROVIDER (its own token type) */
  provider: boolean;
}

export interface V3aBoard {
  arm: "A" | "B";
  prints: { window: number; simulated: boolean; nanoUsdPerSiu: bigint }[];
  printNano: bigint;
  frontierNano: bigint;
  nav: {
    liveFaceMilli: bigint;
    supply: bigint;
    navMicroSiuPerAgu: bigint;
    /** D144 (owner, 2026-11-12): what the reserve alone would support with no buffer support; never a NAV that includes the buffer */
    shadowNavMicroSiuPerAgu: bigint;
    /** D146: what the lab subsidy has paid for unsold front work so far, and at this window's roll, USDC base units */
    subsidyPaidUsdc: bigint;
    subsidyThisWindowUsdc: bigint;
    expectedDefaultMicroSiu: bigint;
  };
  wallet: { usdc: bigint; aguMicroSiu: bigint; claimsMicroSiu: bigint; valueMicroUsd: bigint };
  claims: V3aClaimView[];
  /** D144: claims held in escrow for this research agent's accepted briefs, which it may present for those briefs' own tasks */
  escrowedClaims: (V3aClaimView & { quote: string })[];
  participant: { askMicroUsdPerSiu: bigint; bidMicroUsdPerSiu: bigint; canSellMicroSiu: bigint };
  rollNanoPerSiu: bigint;
  faces: Partial<Record<TaskId, bigint>>;
  frontierFaces: Partial<Record<TaskId, bigint>>;
  dataPriceMicroSiu: MicroSiu;
  issuerList: { issuer: string; task: TaskId; priceMicroSiu: MicroSiu; served: number; presented: number }[];
  needsAhead: { window: number; tasks: TaskId[]; workMicroSiu: MicroSiu; valueMicroUsd: bigint; unmetMicroSiu: MicroSiu }[];
  mandate?: {
    profile: string;
    capMicroSiu: MicroSiu;
    committed: { window: number; microSiu: MicroSiu }[];
    bufferMicroUsd: bigint;
    sweepMicroUsd: bigint;
    sweepWindows: number[];
  };
  armB?: { holdShareBps: bigint; windowsAhead: number; requiredMicroSiu: MicroSiu; heldMicroSiu: MicroSiu };
  offers: Offer[];
  requests: ClaimRequest[];
  /** the claims record per issuer and window, with every discount PROVIDER posted there (D144: its discount history) */
  record: { issuer: string; window: number; row: RecordRow; discounts: { task: string; discountBps: bigint; status: string; offer: string }[] }[];
  provider?: { profitMicroSiu: MicroSiu; headroom: { issuer: string; task: string; milli: bigint }[] };
}

export function v3aBoardFor(w: World, agent: string, role: Role): V3aBoard {
  const v = w.v3a;
  const p = w.params.v3a;
  if (v === undefined || p === undefined) throw new Error("not a v3a world");
  const k = w.window;
  const rate = w.commodityRate;
  const { num, den } = w.chain.nav();
  const supply = w.chain.aguSupply;
  const navMicro = den === 0n ? 0n : (num * 1_000_000n) / den; // micro-SIU per whole AGU-lab
  // expected default losses: each live reserve lot's face, times its issuer's DEFAULT rate so far (presented and never served, over all it served or defaulted) -- a
  // claim its holder let lapse is the holder's loss, not the issuer's default
  let expectedDefault = 0n;
  for (const id of w.chain.reserveLots) {
    const ct = w.chain.claimTypes.get(id);
    const face = w.chain.claimBalance(RESERVE, id);
    if (ct === undefined || face === 0n || ct.windowTo <= w.clock.now || w.chain.retired.has(id)) continue;
    expectedDefault += (face * 1_000n * defaultBpsOf(w, ct.issuer)) / 10_000n;
  }
  const windowOf = (t: number): number => Math.floor((t - w.t0) / w.params.secondsPerWindow);
  const claims: V3aClaimView[] = [];
  for (const [tokenId, holders] of w.chain.claims) {
    const milli = holders.get(agent) ?? 0n;
    const ct = w.chain.claimTypes.get(tokenId);
    if (milli === 0n || ct === undefined || ct.windowTo <= w.clock.now) continue;
    const presentableNow = w.clock.now >= ct.windowFrom && w.clock.now < ct.windowTo;
    const microSiu = ct.series === "commodity" ? milli * 1_000n : (milli * 1_000n * w.rates[ct.series]) / rate;
    claims.push({
      claim: tokenId,
      task: ct.classId,
      issuer: ct.issuer,
      milli,
      window: windowOf(ct.windowFrom),
      presentableNow,
      ...(presentableNow ? { roundsLeft: w.params.roundsPerWindow - w.round } : {}),
      valueMicroUsd: usdcForMicroSiu(microSiu, rate),
      provider: v.providerTokens.has(tokenId),
    });
  }
  const escrowedClaims: (V3aClaimView & { quote: string })[] = [];
  for (const q of w.quotes.filter((x) => x.researcher === agent && x.status === "accepted" && x.claimEscrow !== undefined))
    for (const [tokenId, holders] of w.chain.claims) {
      const milli = holders.get(q.claimEscrow as string) ?? 0n;
      const ct = w.chain.claimTypes.get(tokenId);
      if (milli === 0n || ct === undefined || ct.windowTo <= w.clock.now) continue;
      const presentableNow = w.clock.now >= ct.windowFrom && w.clock.now < ct.windowTo;
      escrowedClaims.push({
        claim: tokenId,
        task: ct.classId,
        issuer: ct.issuer,
        milli,
        window: windowOf(ct.windowFrom),
        presentableNow,
        ...(presentableNow ? { roundsLeft: w.params.roundsPerWindow - w.round } : {}),
        valueMicroUsd: usdcForMicroSiu(milli * 1_000n, rate),
        provider: v.providerTokens.has(tokenId),
        quote: q.id,
      });
    }
  const q = supply > 0n ? w.participant.quote(1_000_000n, rate) : { ask: 0n, bid: 0n };
  // the participant's quote for one whole AGU-lab, restated per SIU of AGU-lab value
  const perSiu = (usdc: bigint): bigint => (navMicro === 0n ? 0n : (usdc * 1_000_000n) / navMicro);
  const needsAhead =
    role === "demand" && w.needsForFn !== undefined
      ? Array.from({ length: p.needsVisibleWindows + 1 }, (_, i) => k + i)
          .filter((x) => x <= (w.totalWindows ?? Number.MAX_SAFE_INTEGER))
          .map((x) => {
            const tasks = [...new Set(w.needsForFn?.(agent, x) ?? [])];
            const work = w.workMicroSiu(tasks);
            return { window: x, tasks, workMicroSiu: work, valueMicroUsd: usdcForMicroSiu(work, rate), unmetMicroSiu: w.unmetNeedCostMicroSiu(tasks) ?? 0n };
          })
      : [];
  const cap = w.v3aCapMicroSiu(agent);
  const m = p.mandates[agent];
  const armB =
    v.run.arm === "B" && p.armB.agents.includes(agent)
      ? {
          holdShareBps: p.armB.holdShareBps,
          windowsAhead: p.armB.windowsAhead,
          requiredMicroSiu: (w.knownNeedsMicroSiu(agent, k, p.armB.windowsAhead) * p.armB.holdShareBps) / 10_000n,
          heldMicroSiu: w.siuOf(w.chain.balance(agent, "AGU")) + w.claimsValueMicroSiu(agent, (x) => x > k && x <= k + p.armB.windowsAhead),
        }
      : undefined;
  const keys = new Set([...v.record.keys(), ...v.offers.map((o) => `${o.issuer}|${o.window}`)]);
  const record = [...keys]
    .map((key) => {
      const issuer = key.split("|")[0] as string;
      const window = Number(key.split("|")[1]);
      return {
        issuer,
        window,
        row: v.record.get(key) ?? emptyRow(),
        discounts: v.offers
          .filter((o) => o.issuer === issuer && o.window === window)
          .map((o) => ({ task: o.task, discountBps: o.discountBps, status: o.status, offer: o.id })),
      };
    })
    .filter((r) => r.window >= k - 2 && r.window <= k + p.providerRules.maxWindowsAhead)
    .sort((a, b) => (a.issuer === b.issuer ? a.window - b.window : a.issuer.localeCompare(b.issuer)));
  return {
    arm: v.run.arm,
    prints: v.run.path
      .filter((x) => x.window <= k)
      .slice(-15)
      .map((x) => ({ window: x.window, simulated: x.simulated, nanoUsdPerSiu: x.rates.commodity })),
    printNano: rate,
    frontierNano: w.rates.frontier,
    nav: {
      liveFaceMilli: w.chain.liveFace(),
      supply,
      navMicroSiuPerAgu: navMicro,
      shadowNavMicroSiuPerAgu: (navMicro * w.shadowNavPpm) / 1_000_000n,
      subsidyPaidUsdc: w.subsidyPaid,
      subsidyThisWindowUsdc: w.subsidyThisWindow,
      expectedDefaultMicroSiu: expectedDefault,
    },
    wallet: {
      usdc: w.chain.balance(agent, "USDC"),
      aguMicroSiu: w.siuOf(w.chain.balance(agent, "AGU")),
      claimsMicroSiu: w.claimsValueMicroSiu(agent),
      valueMicroUsd: w.valueMicroUsd(agent),
    },
    claims,
    escrowedClaims,
    participant: { askMicroUsdPerSiu: perSiu(q.ask), bidMicroUsdPerSiu: perSiu(q.bid), canSellMicroSiu: w.siuOf(w.participantCanSell()) },
    rollNanoPerSiu: (rate * (10_000n - w.params.reserve.discountBps)) / 10_000n,
    faces: v.faces.commodity,
    frontierFaces: v.faces.frontier,
    dataPriceMicroSiu: p.dataPriceMilli * 1_000n,
    issuerList: w.params.issuers.flatMap((i) =>
      i.classes.map((t) => {
        const d = (w.delivery.get(i.id) ?? []).reduce((a, x) => ({ presented: a.presented + x.presented, served: a.served + x.served }), {
          presented: 0,
          served: 0,
        });
        return { issuer: i.id, task: t, priceMicroSiu: w.taskPrice[i.id]?.[t] ?? 0n, ...d };
      }),
    ),
    needsAhead,
    ...(cap !== undefined && m !== undefined
      ? {
          mandate: {
            profile: m.profile,
            capMicroSiu: cap,
            committed: Array.from({ length: p.needsVisibleWindows + 1 }, (_, i) => k + i).map((x) => ({ window: x, microSiu: w.spentFor(agent, x) })),
            bufferMicroUsd: w.v3aBufferMicroUsd(agent) ?? 0n,
            sweepMicroUsd: w.v3aSweepMicroUsd(agent) ?? 0n,
            sweepWindows: p.sweep.windows,
          },
        }
      : {}),
    ...(armB !== undefined ? { armB } : {}),
    offers: v.offers.filter((o) => o.status === "live" && (role === "provider" || o.to === "all" || o.to === agent)),
    requests: v.requests.filter((r) => r.status === "open" && (role === "provider" || r.buyer === agent)),
    record,
    ...(role === "provider"
      ? {
          provider: {
            profitMicroSiu: v.providerProfitMicroSiu,
            headroom: [...w.chain.bondLots.keys()].map((key) => {
              const [issuer, task] = key.split("|") as [string, string];
              return { issuer, task, milli: w.chain.headroom(issuer, task) };
            }),
          },
        }
      : {}),
  };
}

function defaultBpsOf(w: World, issuer: string): bigint {
  let defaulted = 0n;
  let settled = 0n;
  for (const [key, r] of w.v3a?.record ?? []) {
    if (key.split("|")[0] !== issuer) continue;
    defaulted += r.defaultedMilli;
    settled += r.defaultedMilli + r.servedMilli;
  }
  return settled === 0n ? 0n : (defaulted * 10_000n) / settled;
}

// ---- rendering ------------------------------------------------------------------------------------------------------------------------------------------
const group = (n: bigint): string => {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${s}` : s;
};
const msiu = (microSiu: bigint): string => `${group(microSiu / 1_000n)} mSIU`;
const musd = (usdc: bigint): string => `${group(usdc)} µ$`;

export interface RenderCtx {
  agent: string;
  role: Role;
  window: number;
  day: string;
  round: number;
  rounds: number;
  siuFirst: boolean;
  agents: { id: string; role: Role }[];
  needs: { id: string; agent: string; tasks: TaskId[]; status: string }[];
  quotes: {
    id: string;
    researcher: string;
    demand: string;
    tasks: TaskId[];
    priceMicroSiu: bigint;
    priceUnit: string;
    priceUsdcMicro?: bigint;
    status: string;
    accepts?: string;
    agu?: bigint;
    usdcEscrowed?: bigint;
    paidInClaims?: { milli: bigint }[];
  }[];
  outputs: { id: string; task: string; issuer: string; passed: boolean }[];
  notices: string[];
  lastResult?: string;
  objective?: { usdcNet: string; aguNet: string; unmetSiu: string; combinedUsd: string; raw?: { usdcNet: bigint; aguNetMicroSiu: bigint; unmetMicroSiu: bigint; combinedUsdc: bigint }; onTime?: number; late?: number };
  forward?: { sold: number; delivered: number };
}

/** the v3a board as the text a model agent reads */
export function renderV3aBoard(c: RenderCtx, b: V3aBoard): string {
  const rate = b.printNano;
  const both = (microSiu: bigint): string => {
    const usd = usdcForMicroSiu(microSiu, rate);
    return c.siuFirst ? `${msiu(microSiu)} (≈ ${musd(usd)})` : `${musd(usd)} (≈ ${msiu(microSiu)})`;
  };
  const bothUsd = (usdc: bigint): string => {
    const micro = (usdc * 1_000_000_000n) / rate;
    return c.siuFirst ? `${msiu(micro)} (≈ ${musd(usdc)})` : `${musd(usdc)} (≈ ${msiu(micro)})`;
  };
  const perSiu = (nano: bigint): string => musd(nano / 1_000n);
  // D146: an amount of work with its dollar value beside it, in the window's display order (the value is already at the claim's own grade print)
  const workPair = (milli: bigint, usd: bigint): string => (c.siuFirst ? `${group(milli)} mSIU (≈ ${musd(usd)})` : `${musd(usd)} (≈ ${group(milli)} mSIU)`);
  const workAt = (milli: bigint, nano: bigint): string => workPair(milli, usdcForMicroSiu(milli * 1_000n, nano));
  const L: string[] = [];
  L.push(`You are ${c.agent}, a ${c.role} agent. Day ${c.day} (window ${c.window} of 8), round ${c.round} of ${c.rounds}.`);
  L.push(
    `Units: work and AGU-lab are shown in mSIU (a thousandth of a SIU of work), dollars in µ$ (a millionth of a dollar, one USDC base unit). Every amount has its value in the other unit beside it, at today's print.`,
  );
  L.push(
    `Prints (the Commodity print, µ$ per SIU, last ${b.prints.length}; the earlier ones are simulated history, generated before the run): ${b.prints
      .map((p) => `${p.simulated ? `s${p.window}` : `w${p.window}`} ${group(p.nanoUsdPerSiu / 1_000n)}`)
      .join(", ")}. Today: ${perSiu(rate)} per SIU (Frontier ${perSiu(b.frontierNano)}). The next print is published at the next window's open.`,
  );
  const n = b.nav;
  L.push(
    `AGU-lab NAV: the reserve holds ${msiu(n.liveFaceMilli * 1_000n)} of live work claims against ${group(n.supply / 1_000_000n)} AGU-lab issued; expected default losses on them ${both(n.expectedDefaultMicroSiu)}; NAV ${msiu(n.navMicroSiuPerAgu)} per AGU-lab (≈ ${musd(usdcForMicroSiu(n.navMicroSiuPerAgu, rate))}); this is the NAV every AGU-lab price and value here uses. The lab subsidy, which pays for front work the roll could not sell, has paid ${bothUsd(n.subsidyPaidUsdc)} so far (${bothUsd(n.subsidyThisWindowUsdc)} at this window's roll); shadow NAV (what the reserve alone would support with no subsidy): ${msiu(n.shadowNavMicroSiuPerAgu)} per AGU-lab. AGU-lab amounts below are shown by their value at NAV.`,
  );
  L.push(
    `The participant sells AGU-lab at ${musd(b.participant.askMicroUsdPerSiu)} and buys it back at ${musd(b.participant.bidMicroUsdPerSiu)} per SIU of value (NAV × print ± 1%); it can sell up to ${msiu(b.participant.canSellMicroSiu)} right now.`,
  );
  L.push(
    `Your wallet: USDC ${bothUsd(b.wallet.usdc)}; AGU-lab ${both(b.wallet.aguMicroSiu)}; work claims ${both(b.wallet.claimsMicroSiu)}. Total ${musd(b.wallet.valueMicroUsd)}.`,
  );
  if (b.claims.length > 0) {
    L.push("Work claims you hold (one task of a class uses that class's work, below; holdings of the same claim add up):");
    for (const x of b.claims)
      L.push(
        `  - ${x.claim}: ${workPair(x.milli, x.valueMicroUsd)} of ${x.task} from ${x.issuer}${x.provider ? " (sold by PROVIDER)" : ""}, window ${x.window}${x.presentableNow ? `, presentable NOW, ${x.roundsLeft} round(s) left before it lapses worthless` : `, deadline: the end of window ${x.window}`}`,
      );
  }
  if (b.escrowedClaims.length > 0) {
    L.push("Work claims held in escrow for your accepted briefs (present them for the brief's own tasks; what is left is yours when the brief passes):");
    for (const x of b.escrowedClaims)
      L.push(
        `  - ${x.claim}: ${workPair(x.milli, x.valueMicroUsd)} of ${x.task} from ${x.issuer}, for ${x.quote}, window ${x.window}${x.presentableNow ? `, presentable NOW, ${x.roundsLeft} round(s) left` : ""}`,
      );
  }
  L.push(
    `One task's work: ${Object.entries(b.faces)
      .map(([t, f]) => `${t} ${f} mSIU`)
      .join(", ")} (Commodity); ${Object.entries(b.frontierFaces)
      .map(([t, f]) => `${t} ${f} mSIU`)
      .join(", ")} (Frontier). Fixed for the run: a claim always buys this much work.`,
  );
  L.push(`Front-claim roll: claims for the next window at ${perSiu(b.rollNanoPerSiu)} per SIU, payable in USDC or AGU-lab.`);
  L.push(`Agents: ${c.agents.map((a) => `${a.id} (${a.role})`).join(", ")}. A message goes to one of them, or to "all".`);
  if (b.mandate !== undefined) {
    const m = b.mandate;
    L.push(
      `Your mandate (${m.profile}): spend at most ${both(m.capMicroSiu)} for the work of any one window, counted against the window the work is for (committed so far: ${m.committed
        .map((x) => `w${x.window} ${group(x.microSiu / 1_000n)}`)
        .join(", ")} mSIU); keep at least ${musd(m.bufferMicroUsd)} of total value. Your owner takes ${musd(m.sweepMicroUsd)} in USDC at the end of windows ${m.sweepWindows.join(" and ")}; if your USDC is short then, your AGU-lab is sold at the bid to cover it, and if that is not enough, your work claims too, soonest-expiring first, at the same bid.`,
    );
  }
  if (b.armB !== undefined)
    L.push(
      `Your owner's rule: at each window close, hold AGU-lab or work claims for the next ${b.armB.windowsAhead} windows worth at least ${Number(b.armB.holdShareBps) / 100}% of your known needs in those windows. Now: ${msiu(b.armB.heldMicroSiu)} held against ${msiu(b.armB.requiredMicroSiu)} required.`,
    );
  if (c.forward !== undefined)
    L.push(
      `You hold a standing obligation: ${c.forward.sold} briefs owed over the run, ${c.forward.delivered} delivered so far. Each needs passing outputs of two task types from the same day.`,
    );
  if (b.needsAhead.length > 0) {
    L.push("Your needs (each a brief covering two task types), with each one's work content and what it costs your result if it is still unmet when its window ends:");
    for (const x of b.needsAhead)
      L.push(
        `  - window ${x.window}${x.window === c.window ? " (now)" : ""}: ${x.tasks.join(" + ")}, work content ${both(x.workMicroSiu)}, before research costs such as data; if unmet at the window's end, ${both(x.unmetMicroSiu)} is charged to your result`,
      );
  }
  if (c.needs.length > 0) {
    L.push(c.role === "demand" ? "Your needs this window:" : "Open needs this window (demand agents want briefs):");
    for (const x of c.needs) L.push(`  - ${x.id} of ${x.agent}: ${x.tasks.join(" + ")} (${x.status})`);
  }
  if (c.quotes.length > 0) {
    L.push("Quotes:");
    for (const q of c.quotes) {
      const price = q.priceUnit === "usdc" ? bothUsd(q.priceUsdcMicro ?? 0n) : both(q.priceMicroSiu);
      const held =
        q.paidInClaims !== undefined
          ? `, paid in work claims (${group(q.paidInClaims.reduce((s, x) => s + x.milli, 0n))} mSIU, held in escrow until the brief passes)`
          : q.agu !== undefined
            ? ", in escrow in AGU-lab"
            : q.usdcEscrowed !== undefined
              ? `, ${musd(q.usdcEscrowed)} in escrow in USDC`
              : "";
      L.push(
        `  - ${q.id}: ${q.researcher} → ${q.demand}, ${q.tasks.join(" + ")} for ${price}, accepting ${q.accepts === "both" ? "USDC or AGU-lab" : q.accepts === "usdc" ? "USDC" : "AGU-lab"} or claims, ${q.status}${held}`,
      );
    }
  }
  if (b.offers.length > 0) {
    L.push("PROVIDER's offers:");
    for (const o of b.offers) {
      const nano = (b.printNano * (10_000n - o.discountBps)) / 10_000n;
      L.push(
        `  - ${o.id}: up to ${workAt(o.milliLeft, o.series === "commodity" ? rate : b.frontierNano)} of ${o.task} from ${o.issuer} for window ${o.window}, ${o.discountBps >= 0n ? `${Number(o.discountBps) / 100}% below` : `${-Number(o.discountBps) / 100}% above`} the ${o.series} print (${o.series === "commodity" ? perSiu(nano) : "Frontier"} per SIU), accepts ${o.accept === "both" ? "USDC or AGU-lab" : o.accept === "usdc" ? "USDC" : "AGU-lab"}${o.to !== "all" ? `, to ${o.to} only` : ""}${o.request !== undefined ? `, answering ${o.request}` : ""}`,
      );
    }
  }
  if (b.requests.length > 0) {
    L.push(c.role === "provider" ? "Open requests from buyers:" : "Your open requests to PROVIDER:");
    for (const r of b.requests) L.push(`  - ${r.id}: ${r.buyer} asks for ${workAt(r.milli, r.task === "CR-VS" ? b.frontierNano : rate)} of ${r.task} for window ${r.window}`);
  }
  if (b.provider !== undefined) {
    L.push(`Your running result: ${both(b.provider.profitMicroSiu)} of profit in SIU so far (sales, less issuers' costs when they serve, less defaults on claims you sold).`);
    L.push(`Issuers' headroom for claims now: ${b.provider.headroom.map((h) => `${h.issuer} ${h.task} ${group(h.milli)} mSIU`).join(", ")}.`);
  }
  if (b.record.length > 0) {
    L.push("Claims record (mSIU minted; tasks presented and redeemed; mSIU defaulted and expired in agents' hands; every discount PROVIDER posted):");
    const pctOff = (bps: bigint): string => (bps >= 0n ? `${Number(bps) / 100}% off` : `${-Number(bps) / 100}% premium`);
    for (const r of b.record)
      L.push(
        `  - ${r.issuer} window ${r.window}: minted ${group(r.row.mintedMilli)}, presented ${r.row.presented}, redeemed ${r.row.served}, defaulted ${group(r.row.defaultedMilli)}, expired ${group(r.row.expiredMilli)}${r.discounts.length > 0 ? `; PROVIDER posted ${r.discounts.map((d) => `${d.task} ${pctOff(d.discountBps)} (${d.status})`).join(", ")}` : ""}`,
      );
  }
  if (c.outputs.length > 0) {
    L.push("Your task outputs from today (unused):");
    for (const o of c.outputs) L.push(`  - ${o.id}: ${o.task} by ${o.issuer}, ${o.passed ? "PASSED" : "FAILED"}`);
  }
  if (c.role === "research" || c.role === "hedger") {
    L.push("Issuers' list prices per task (escrowed, paid only on a pass; payable in USDC or AGU-lab), with their delivery so far:");
    for (const i of b.issuerList)
      L.push(`  - ${i.issuer} ${i.task}: ${both(i.priceMicroSiu)}; ${i.served} of ${i.presented} tasks passed`);
  }
  if (c.role === "research") L.push(`A dataset costs ${both(b.dataPriceMicroSiu)} a day, in USDC or AGU-lab; buy it before a task on it.`);
  // D146: the running result in board units, the other unit beside each amount
  if (c.objective?.raw !== undefined && c.role !== "provider") {
    const o = c.objective;
    const r = o.raw as NonNullable<typeof o.raw>;
    L.push(
      `Your running result: ${bothUsd(r.usdcNet)} net in USDC, ${both(r.aguNetMicroSiu)} net in AGU-lab${r.unmetMicroSiu !== 0n ? `, ${both(r.unmetMicroSiu)} charged for unmet needs` : ""} -- combined, ${bothUsd(r.combinedUsdc)}${o.onTime !== undefined ? ` (${o.onTime} on time, ${o.late} late or missing)` : ""}.`,
    );
  }
  if (c.notices.length > 0) {
    L.push("Since your last turn:");
    for (const x of c.notices) L.push(`  - ${x}`);
  }
  if (c.lastResult !== undefined) L.push(`Your last action: ${c.lastResult}`);
  return L.join("\n");
}
