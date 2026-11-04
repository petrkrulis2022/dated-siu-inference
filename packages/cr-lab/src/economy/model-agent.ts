/**
 * A model in an agent seat (WP7): it reads its role's instructions and its board, and replies with one JSON object, reasoning first (§3.3). Every call goes through the trial's spend
 * ledger guard (part `economy`), so its projected cost is reserved against the daily cap and the provider's budget before it is made, and a refused call stops the run.
 *
 * The instructions describe the market and the tools and say nothing about which way to pay: whether agents use AGU-lab when they are not forced to is what the economy measures
 * (§16.9, the thesis), so no instruction may lean on it.
 */
import { D } from "@touchstone/sdk";
import type { ToolChat } from "../mcp/tool-loop.js";
import { usageCostUsd, type ModelPrice } from "../runner/prices.js";
import type { SpendLedger } from "../spend/ledger.js";
import type { Agent, AgentReply } from "./agents.js";
import type { Board } from "./board.js";
import { TOOL_HELP, TOOLS_BY_ROLE } from "./parse.js";
import type { Role } from "./world.js";

export class ModelAgent implements Agent {
  constructor(
    readonly id: string,
    readonly role: Role,
    readonly seat: string,
    readonly chat: ToolChat,
    readonly price: ModelPrice,
    readonly ledger: SpendLedger,
    readonly keyName: string,
    readonly maxTokens = 2_000,
  ) {}

  async reply(board: Board, prompt: string): Promise<AgentReply> {
    // a generous projection: a token is at least three characters of English, and the whole allowance is assumed spent
    const projected = usageCostUsd(
      {
        input: Math.ceil(prompt.length / 3),
        output: this.maxTokens,
        cached_input: 0,
        reasoning: 0,
      },
      this.price,
      this.chat.provider,
    );
    const r = await this.ledger.guard(
      this.chat.provider,
      projected.toFixed(6),
      {
        part: "economy",
        model: this.seat,
        key: this.keyName,
        what: `${this.id} w${board.window} r${board.round}`,
      },
      async () => {
        const turn = await this.chat.send(this.chat.init(prompt), undefined, this.maxTokens);
        if (turn.status !== 200 || turn.reply === undefined)
          return { usd: "0", text: "", failure: `model call failed (status ${turn.status})` };
        const u = turn.reply.usage;
        const usd = usageCostUsd(
          {
            input: u.input,
            output: u.output,
            cached_input: u.cachedInput,
            reasoning: u.reasoning ?? 0,
          },
          this.price,
          this.chat.provider,
        );
        return { usd: usd.toFixed(6), text: turn.reply.text, failure: undefined };
      },
    );
    return {
      text: r.text,
      costUsd: new D(r.usd),
      ...(r.failure !== undefined ? { serviceFailure: r.failure } : {}),
    };
  }
}

const COMMON = [
  "You are one agent in a small closed market for crypto-research work. Each day is one window of several rounds; on each round you take exactly one action.",
  "Work is done by issuers: AI models that answer research tasks of four types (CR-VS perp DEX volume share, CR-PL lending protocol P&L, CR-UO token unlock overhang, CR-SM stablecoin supply moves). An answer is checked by an objective gate; it PASSES or FAILS.",
  "Prices inside the market are quoted in SIU (one SIU is one correct answer to each of the four task types) and paid in AGU-lab, a token whose value is its reserve of work claims (its NAV, in SIU per AGU-lab). The authorised participant sells AGU-lab for USDC and buys it back, at prices on your board.",
  "Payments for work and for briefs go into escrow and are released only if the work passes; a failed piece of work pays nothing and the buyer gets the full amount back.",
  "AGU-lab can also be redeemed in kind: you receive your share of the reserve's work claims. A work claim is presented to its issuer in its own window for one task; a claim never presented lapses worthless at the end of its window.",
  "You may also order work claims for the next window, paid in USDC at a discount to the print, and you may sell AGU-lab back for USDC at any time. Use whichever routes suit your goals.",
];
const ROLE: Record<Role, string> = {
  demand:
    "You are a DEMAND agent. Your owner gave you a mandate (on your board) and each window you have a need: a brief covering two task types. Research agents quote briefs to you; you choose whether and how to get your needs met.",
  research:
    "You are a RESEARCH agent. Demand agents have needs for briefs. You can quote a brief, buy the day's data, commission task work from issuers, and deliver the brief from passing outputs of today. You are paid only if every part of the brief passes.",
  hedger:
    "You are the HEDGER. You sold briefs forward for USDC and must deliver them over the coming windows, each from two passing outputs of different task types from the same day. You can buy work claims ahead, present claims, or commission work.",
};

/** a role's standing instructions, with its tools and the reply format */
export function instructionsFor(role: Role): string {
  const tools = TOOLS_BY_ROLE[role].map((t) => `  - ${t} ${TOOL_HELP[t] ?? ""}`).join("\n");
  return [
    ...COMMON,
    ROLE[role],
    "Your tools (amounts are plain decimal strings):",
    tools,
    'Reply with exactly one JSON object and nothing else, reasoning first: {"reasoning": "why, in a few sentences", "action": {"tool": "<tool>", "args": {...}}}',
  ].join("\n");
}
