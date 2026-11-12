/**
 * Scripted v3a agents: simple, deterministic policies chosen so a free development run exercises every v3a path (docs/experiment-3a-design.md) -- PROVIDER's offers,
 * revisions, withdrawals and answers to requests; buying claims ahead and paying for briefs in USDC, AGU-lab and claims; the roll paid in AGU-lab; redemption; forward
 * deliveries. They are not a model of good behaviour, and their currency choices are mechanical (whichever the agent holds more of), never a finding.
 *
 * Their replies go through the same v3a parser as a model's (`parse.ts`), so the tool schemas and every rule are exercised exactly as a model's turn would exercise them.
 */
import { D } from "@touchstone/sdk";
import type { TaskId } from "../tasks/instances.js";
import type { Agent, AgentReply } from "./agents.js";
import type { Board } from "./board.js";
import type { V3aBoard } from "./board-v3a.js";
import { usdcForMicroSiu } from "./units.js";
import type { Role } from "./world.js";

const reply = (reasoning: string, tool: string, args: Record<string, unknown> = {}): AgentReply => ({
  toolCall: { tool, args: { reasoning, ...args } },
  costUsd: new D(0),
});
const pass = (): AgentReply => reply("Nothing to do this round.", "pass");

/** pay in whichever currency covers `microSiu` and of which the agent holds more value */
function payFor(b: Board, v: V3aBoard, microSiu: bigint): "usdc" | "agu" | undefined {
  const usdcNeeded = usdcForMicroSiu(microSiu, v.printNano) + 1n;
  const canUsdc = v.wallet.usdc >= usdcNeeded;
  const canAgu = v.wallet.aguMicroSiu >= microSiu + 1_000n;
  if (canUsdc && canAgu) return (v.wallet.aguMicroSiu * v.printNano) / 1_000_000_000n > v.wallet.usdc ? "agu" : "usdc";
  return canUsdc ? "usdc" : canAgu ? "agu" : undefined;
}

const COMMODITY: readonly TaskId[] = ["CR-PL", "CR-UO", "CR-SM"];

export class ScriptedV3aAgent implements Agent {
  readonly seat = "scripted";
  constructor(
    readonly id: string,
    readonly role: Role,
  ) {}

  reply(b: Board): Promise<AgentReply> {
    const v = b.v3a;
    if (v === undefined) throw new Error("ScriptedV3aAgent needs a v3a board");
    return Promise.resolve(
      this.role === "provider"
        ? this.#provider(b, v)
        : this.role === "demand"
          ? this.#demand(b, v)
          : this.role === "research"
            ? this.#research(b, v)
            : this.#hedger(b, v),
    );
  }

  #provider(b: Board, v: V3aBoard): AgentReply {
    const req = v.requests[0];
    if (req !== undefined) {
      if (req.window > b.window + 3) return reply(`Too far ahead.`, "decline_request", { request: req.id, reason: "too far ahead" });
      return reply(`Answering ${req.id}.`, "post_offer", {
        issuer: "ISSUER-C2",
        task: req.task,
        window: req.window,
        msiu: req.milli.toString(),
        discount_bps: 300,
        accept: "both",
        to: req.buyer,
        request: req.id,
      });
    }
    const next = b.window + 1;
    if (b.round <= 2 && next <= 8) {
      // one standing offer per class for the next window: CR-UO from the cheaper, less reliable ISSUER-X at a deeper discount
      for (const [task, issuer, discount] of [
        ["CR-PL", "ISSUER-C1", 200],
        ["CR-UO", "ISSUER-X", 1_500],
        ["CR-SM", "ISSUER-C2", 0],
      ] as const) {
        const room = v.provider?.headroom.find((h) => h.issuer === issuer && h.task === task)?.milli ?? 0n;
        const size = room < 2_000n ? room : 2_000n;
        if (size > 0n && !v.offers.some((o) => o.task === task && o.window === next))
          return reply(`Offering ${task} for window ${next}.`, "post_offer", {
            issuer,
            task,
            window: next,
            msiu: size.toString(),
            discount_bps: discount,
            accept: "both",
            to: "all",
          });
      }
    }
    const uo = v.offers.find((o) => o.task === "CR-UO" && o.window === next && o.discountBps === 1_500n);
    if (b.round === 3 && uo !== undefined)
      return reply(`Revising ${uo.id}.`, "post_offer", {
        issuer: "ISSUER-X",
        task: "CR-UO",
        window: next,
        msiu: uo.milliLeft.toString(),
        discount_bps: 1_200,
        accept: "both",
        to: "all",
        replaces: uo.id,
      });
    const stale = v.offers.find((o) => o.window === b.window);
    if (b.round === 7 && stale !== undefined) return reply(`Withdrawing ${stale.id}.`, "withdraw_offer", { offer: stale.id });
    return pass();
  }

  #demand(b: Board, v: V3aBoard): AgentReply {
    const open = b.needs.find(
      (n) => n.status === "open" && n.window === b.window && !b.quotes.some((q) => q.need === n.id && q.status === "accepted"),
    );
    const offers = b.quotes.filter((q) => q.status === "posted" && open !== undefined && q.need === open.id);
    const best = offers.sort((x, y) => (x.priceMicroSiu < y.priceMicroSiu ? -1 : 1))[0];
    if (best !== undefined) {
      const mine = v.claims.filter((c) => c.window === b.window && best.tasks.includes(c.task as TaskId));
      const claimValue = mine.reduce((s, c) => s + c.milli * 1_000n, 0n);
      if (claimValue >= best.priceMicroSiu)
        return reply(`Paying ${best.id} with the claims I bought ahead.`, "accept_quote", {
          quote: best.id,
          pay: "claims",
          claims: mine.map((c) => c.claim),
        });
      const pay = payFor(b, v, best.priceMicroSiu);
      if (pay !== undefined) return reply(`Accepting ${best.id}.`, "accept_quote", { quote: best.id, pay });
    }
    const ahead = v.needsAhead.find((n) => n.window === b.window + 1);
    if (b.round <= 1 && ahead !== undefined)
      for (const t of ahead.tasks) {
        const face = v.faces[t] ?? 0n;
        if (v.claims.some((c) => c.task === t && c.window === ahead.window)) continue;
        const o = v.offers.find((x) => x.task === t && x.window === ahead.window && x.milliLeft >= face);
        const pay = payFor(b, v, face * 1_000n);
        if (o !== undefined && pay !== undefined)
          return reply(`Buying ${t} work ahead for window ${ahead.window}.`, "buy_offer", { offer: o.id, msiu: face.toString(), pay });
      }
    if (this.id === "DEMAND-3" && b.round === 2 && b.window <= 6) {
      const later = v.needsAhead.find((n) => n.window === b.window + 2);
      if (later !== undefined && v.requests.length === 0)
        return reply("Asking PROVIDER for claims two windows out.", "request_claims", {
          task: later.tasks[0],
          window: later.window,
          msiu: String(v.faces[later.tasks[0] as TaskId] ?? 100n),
        });
    }
    if (this.id === "DEMAND-1" && b.window === 1 && b.round === 5 && ahead !== undefined)
      return reply("Ordering tomorrow's work from the roll, paid in AGU-lab.", "order_front_claim", {
        task: ahead.tasks[0],
        msiu: String(v.faces[ahead.tasks[0] as TaskId] ?? 100n),
        pay: "agu",
      });
    if (this.id === "DEMAND-4" && b.window === 2 && b.round === 3 && v.wallet.aguMicroSiu > 400_000n)
      return reply("Redeeming some AGU-lab in kind.", "redeem_agu", { msiu: "300" });
    return pass();
  }

  #research(b: Board, v: V3aBoard): AgentReply {
    const presentable = [...v.escrowedClaims, ...v.claims].find((c) => c.presentableNow && c.milli >= (v.faces[c.task as TaskId] ?? 1n));
    if (presentable !== undefined)
      return reply(`Presenting ${presentable.claim} for the brief's work.`, "present_claim", { claim: presentable.claim });
    const issuer = this.id === "RESEARCH-1" ? "ISSUER-C1" : this.id === "RESEARCH-2" ? "ISSUER-X" : "ISSUER-C2";
    for (const q of b.quotes.filter((x) => x.researcher === this.id && x.status === "accepted")) {
      const passing = new Set(b.outputs.filter((o) => o.passed).map((o) => o.task));
      if (q.tasks.every((t) => passing.has(t))) return reply(`Delivering ${q.id}.`, "deliver_brief", { quote: q.id });
      const missing = q.tasks.filter((t) => !passing.has(t));
      const cost = missing.reduce((s, t) => s + (v.issuerList.find((i) => i.issuer === issuer && i.task === t)?.priceMicroSiu ?? 0n), 0n);
      const pay = payFor(b, v, cost + v.dataPriceMicroSiu * 2n);
      if (pay !== undefined && q.paidInClaims === undefined)
        return reply(`Commissioning ${missing.join(" + ")} for ${q.id}.`, "commission_task", { tasks: missing, issuer, pay });
      if (pay !== undefined && q.paidInClaims !== undefined && !v.escrowedClaims.some((c) => c.quote === q.id && c.presentableNow))
        return reply(`Commissioning what the claims did not cover for ${q.id}.`, "commission_task", { tasks: missing, issuer, pay });
    }
    const idx = Number(this.id.slice(-1)) - 1;
    const quoted = new Set(b.quotes.filter((q) => q.researcher === this.id).map((q) => q.need));
    const need = b.needs.filter((n, i) => n.status === "open" && i % 3 === idx && !quoted.has(n.id))[0];
    if (need !== undefined) {
      const work = need.tasks.reduce((s, t) => s + (v.faces[t] ?? 0n), 0n);
      return reply(`Quoting ${need.agent}'s need at its work plus a fifth.`, "post_quote", {
        need: need.id,
        tasks: need.tasks,
        price_msiu: ((work * 12n) / 10n).toString(),
        accept: "both",
      });
    }
    return pass();
  }

  #hedger(b: Board, v: V3aBoard): AgentReply {
    const presentable = v.claims.find((c) => c.presentableNow && c.milli >= (v.faces[c.task as TaskId] ?? 1n));
    if (presentable !== undefined) return reply(`Presenting ${presentable.claim}.`, "present_claim", { claim: presentable.claim });
    const passing = new Set(b.outputs.filter((o) => o.passed).map((o) => o.task));
    if (passing.size >= 2 && b.forward !== undefined && b.forward.delivered < b.forward.sold)
      return reply("Two passing outputs: delivering a forward brief.", "deliver_forward");
    if (b.round <= 1)
      for (const t of ["CR-UO", "CR-SM"] as const) {
        const face = v.faces[t] ?? 0n;
        if (v.claims.some((c) => c.task === t && c.window === b.window + 1)) continue;
        const o = v.offers.find((x) => x.task === t && x.window === b.window + 1 && x.milliLeft >= face);
        const pay = payFor(b, v, face * 1_000n);
        if (o !== undefined && pay !== undefined)
          return reply(`Covering a forward brief: ${t} for window ${b.window + 1}.`, "buy_offer", { offer: o.id, msiu: face.toString(), pay });
      }
    if (b.round === 4 && passing.size < 2 && b.forward !== undefined && b.forward.delivered < b.forward.sold) {
      const missing = COMMODITY.filter((t) => t !== "CR-PL" && !passing.has(t));
      const cost = missing.reduce((s, t) => s + (v.issuerList.find((i) => i.issuer === "ISSUER-C1" && i.task === t)?.priceMicroSiu ?? 0n), 0n);
      const pay = payFor(b, v, cost);
      if (missing.length > 0 && pay !== undefined)
        return reply("Commissioning the rest of a forward brief.", "commission_task", { tasks: missing, issuer: "ISSUER-C1", pay });
    }
    return pass();
  }
}
