/**
 * The agents an economy window runs, and the task worker behind the issuers.
 *
 *  - An `Agent` replies to its board with one JSON object (§3.3). Scripted agents (development windows DW0 and DW1, free) build that object from the structured board and go through
 *    the same parser as a model, so the parser, the log and every rule are exercised exactly as a model's turn would exercise them.
 *  - The `StandInWorker` does an issuer's task work without a model and without data, labelled `stand-in`: a pass is drawn from the seed at that issuer model's measured pass rate on
 *    that task type (WP0), and ISSUER-X additionally fails its published share. It spends nothing.
 */
import { D, type DecimalValue } from "@touchstone/sdk";
import type { TaskId } from "../tasks/instances.js";
import { SeedStream } from "../tasks/seeds.js";
import type { Board } from "./board.js";
import type { IssuerParams } from "./params.js";
import { show } from "./units.js";
import type { Role, TaskWorker, WorkOutcome } from "./world.js";

export interface AgentReply {
  text: string;
  costUsd: DecimalValue;
  /** the provider failed (after its own retries): the turn is a service failure, not the agent's, and is not counted as a parse failure */
  serviceFailure?: string;
  /** the provider's stop reason, so a reply cut off at the output allowance reads as that and not as the agent's format */
  stopReason?: string;
  /** the provider's OWN reasoning/thinking summary for this turn, when it returns one (`ChatReply.reasoning`) -- distinct from `parsed.reasoning`, the model's stated reasoning inside its own JSON reply; absent where a model/provider does not return one */
  reasoningSummary?: string;
}
export interface Agent {
  id: string;
  role: Role;
  /** "scripted" or a model id */
  seat: string;
  reply(board: Board, prompt: string): Promise<AgentReply>;
}

export class StandInWorker implements TaskWorker {
  constructor(
    readonly seed: string,
    /** pass rate per model per task type, basis points (from WP0's measured rates) */
    readonly passBps: Readonly<Record<string, Partial<Record<TaskId, number>>>>,
    readonly dataSha: (window: number) => string,
  ) {}

  work(
    issuer: IssuerParams,
    task: TaskId,
    ctx: { window: number; round: number; key: string },
  ): Promise<WorkOutcome> {
    const s = new SeedStream(this.seed, `work:${issuer.id}:${task}:${ctx.window}:${ctx.key}`);
    const bps = this.passBps[issuer.model]?.[task] ?? 0;
    let passed = s.next(10_000) < bps;
    if (passed && issuer.failShareBps > 0n && s.next(10_000) < Number(issuer.failShareBps))
      passed = false;
    return Promise.resolve({ passed, costUsd: new D(0), dataSha: this.dataSha(ctx.window) });
  }
}

const reply = (
  reasoning: string,
  tool: string,
  args: Record<string, unknown> = {},
): AgentReply => ({
  text: JSON.stringify({ reasoning, action: { tool, args } }),
  costUsd: new D(0),
});

/**
 * Scripted policies: simple, deterministic, and chosen so a development window exercises every path the pass criteria name (§6): briefs that pass and fail, AGU-lab bought,
 * spent onward, redeemed in kind, a front-claim order, an exit, the roll. They are not a model of good behaviour.
 */
export class ScriptedAgent implements Agent {
  readonly seat = "scripted";
  constructor(
    readonly id: string,
    readonly role: Role,
    /** the issuer this research agent buys from (RESEARCH-2 uses ISSUER-X, which fails a published share) */
    readonly preferredIssuer = "ISSUER-C1",
  ) {}

  reply(b: Board): Promise<AgentReply> {
    return Promise.resolve(
      this.role === "demand"
        ? this.#demand(b)
        : this.role === "research"
          ? this.#research(b)
          : this.#hedger(b),
    );
  }

  #demand(b: Board): AgentReply {
    const presentable = b.claims.find((c) => c.presentableNow);
    if (presentable !== undefined)
      return reply(
        `I hold claim ${presentable.claim}, presentable now: using it before it lapses.`,
        "present_claim",
        { claim: presentable.claim },
      );
    if (this.id === "DEMAND-3" && b.window === 1 && b.round === 4 && b.askUsdcPerAgu > 0n)
      return reply("Buying AGU-lab to take some of it as work claims in kind.", "buy_agu", {
        usdc: show(b.askUsdcPerAgu),
      });
    if (this.id === "DEMAND-3" && b.window === 1 && b.round === 5 && b.agu > 1_000n)
      return reply(
        "Testing redemption: taking part of my AGU-lab as work claims in kind.",
        "redeem_agu",
        { agu: show(b.agu / 2n) },
      );
    const open = b.needs.find((n) => n.status === "open");
    const offer = b.quotes
      .filter((q) => q.status === "posted" && open !== undefined && q.need === open.id)
      .sort((x, y) => (x.priceMicroSiu < y.priceMicroSiu ? -1 : 1))[0];
    if (offer !== undefined && b.aguSiuValue >= offer.priceMicroSiu)
      return reply(
        `Quote ${offer.id} covers my need ${offer.need}; paying in AGU-lab through escrow.`,
        "accept_quote",
        { quote: offer.id },
      );
    if (b.round === 0 && b.agu === 0n && b.askUsdcPerAgu > 0n)
      return reply(
        "I hold no AGU-lab and briefs are paid in it: buying a working balance.",
        "buy_agu",
        { usdc: show((b.askUsdcPerAgu * 3n) / 2n) },
      );
    if (offer !== undefined && b.aguSiuValue < offer.priceMicroSiu && b.askUsdcPerAgu > 0n)
      return reply("My AGU-lab is short of the quote: topping up.", "buy_agu", {
        usdc: show(b.askUsdcPerAgu),
      });
    if (this.id === "DEMAND-2" && b.round === 6 && b.agu > 1_000n)
      return reply(
        "I will need CR-PL work tomorrow and the discounted claims are cheaper in dollars: selling some AGU-lab to fund a front-claim order.",
        "sell_agu",
        { agu: show(b.agu / 5n) },
      );
    if (this.id === "DEMAND-2" && b.round === 7)
      return reply("Ordering tomorrow's CR-PL work at the roll's discount.", "order_front_claim", {
        task: "CR-PL",
        siu: "0.25",
      });
    return reply("Nothing to do this round.", "pass");
  }

  #research(b: Board): AgentReply {
    const mine = b.needs
      .filter((n) => n.status === "open")
      .filter((n, i) => (this.id === "RESEARCH-1" ? i % 2 === 0 : i % 2 === 1));
    const quoted = new Set(b.quotes.filter((q) => q.researcher === this.id).map((q) => q.need));
    const unquoted = mine.find((n) => !quoted.has(n.id));
    if (unquoted !== undefined) {
      const price = unquoted.tasks
        .map(
          (t) =>
            b.issuerPrices
              .filter((p) => p.task === t && p.issuer === this.preferredIssuer)
              .map((p) => p.priceMicroSiu)[0] ?? 0n,
        )
        .reduce((a, x) => a + x, 0n);
      return reply(
        `Quoting ${unquoted.agent}'s need at my issuer's cost plus a fifth.`,
        "post_quote",
        {
          need: unquoted.id,
          tasks: unquoted.tasks,
          // a quote is priced in whole mSIU (owner, 2026-11-07): round the marked-up micro-SIU cost up to the next whole mSIU, never down, so the quote never prices below cost
          price_msiu: (((price * 12n) / 10n + 999n) / 1_000n).toString(),
        },
      );
    }
    const accepted = b.quotes.filter((q) => q.researcher === this.id && q.status === "accepted");
    for (const q of accepted) {
      const have = q.tasks.every((t) => b.outputs.some((o) => o.task === t));
      if (have)
        return reply(`I have outputs for every part of ${q.id}: delivering.`, "deliver_brief", {
          quote: q.id,
        });
      const missing = q.tasks.filter((t) => !b.outputs.some((o) => o.task === t));
      const cost = missing
        .map(
          (t) =>
            b.issuerPrices.find((p) => p.task === t && p.issuer === this.preferredIssuer)
              ?.priceMicroSiu ?? 0n,
        )
        .reduce((a, x) => a + x, 0n);
      if (b.aguSiuValue < cost)
        return reply("I need AGU-lab to pay the issuer: buying some.", "buy_agu", {
          usdc: show(b.askUsdcPerAgu),
        });
      return reply(
        `Commissioning ${missing.join(" + ")} from ${this.preferredIssuer} for ${q.id}.`,
        "commission_task",
        { tasks: missing, issuer: this.preferredIssuer },
      );
    }
    return reply("Nothing to do this round.", "pass");
  }

  #hedger(b: Board): AgentReply {
    const presentable = b.claims.find((c) => c.presentableNow);
    if (presentable !== undefined)
      return reply(`Presenting ${presentable.claim} to cover a forward brief.`, "present_claim", {
        claim: presentable.claim,
      });
    const passedTypes = new Set(b.outputs.filter((o) => o.passed).map((o) => o.task));
    if (passedTypes.size >= 2 && b.forward !== undefined && b.forward.delivered < b.forward.sold)
      return reply(
        "Two passing outputs of different types: delivering a forward brief.",
        "deliver_forward",
      );
    if (b.round === 0)
      return reply(
        "Buying tomorrow's CR-PL claims ahead to cover my forward briefs.",
        "buy_claims",
        { task: "CR-PL", siu: "0.25", windows_ahead: 1 },
      );
    if (b.round === 1)
      return reply("Buying tomorrow's CR-UO claims ahead too.", "buy_claims", {
        task: "CR-UO",
        siu: "0.25",
        windows_ahead: 1,
      });
    return reply("Nothing to do this round.", "pass");
  }
}
