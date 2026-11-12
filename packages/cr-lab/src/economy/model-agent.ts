/**
 * A model in an agent seat (WP7): it reads its role's instructions and its board, and replies by calling exactly one of its role's tools, reasoning first (§3.3, native
 * tool-calling since D137 -- `tool_choice: {type: "any"}`, no free-text reply is possible any more). Every call goes through the trial's spend ledger guard (part `economy`),
 * so its projected cost is reserved against the daily cap and the provider's budget before it is made, and a refused call stops the run.
 *
 * The instructions describe the market and say nothing about which way to pay: whether agents use AGU-lab when they are not forced to is what the economy measures (§16.9, the
 * thesis), so no instruction may lean on it.
 */
import { D } from "@touchstone/sdk";
import type { ToolChat } from "../mcp/tool-loop.js";
import { usageCostUsd, type ModelPrice } from "../runner/prices.js";
import type { SpendLedger } from "../spend/ledger.js";
import type { Agent, AgentReply } from "./agents.js";
import type { Board } from "./board.js";
import { toolDefsForRole } from "./parse.js";
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
    /** the output allowance of a turn, thinking included: 2,000 cut claude-sonnet-5 off before its answer in 2 of 18 turns (found 2026-11-05) */
    readonly maxTokens = 8_000,
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
        // v3a: a v3a board carries its own section, and its agents get v3a's tools (amounts in mSIU and µ$, every payment naming its currency)
        const specs = this.chat.toolSpecs(toolDefsForRole(this.role, board.v3a !== undefined ? "v3a" : "v2"));
        const turn = await this.chat.send(this.chat.init(prompt), specs, this.maxTokens, {
          forceTool: true,
        });
        if (turn.status !== 200 || turn.reply === undefined)
          return {
            usd: "0",
            toolCall: undefined,
            failure: `model call failed (status ${turn.status})`,
            stopReason: undefined,
          };
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
        const use = turn.reply.toolUses[0];
        return {
          usd: usd.toFixed(6),
          toolCall: use === undefined ? undefined : { tool: use.name, args: use.args },
          failure: undefined,
          stopReason: turn.reply.stopReason,
          // the provider's OWN reasoning/thinking summary, if it returns one -- previously read and silently dropped
          reasoningSummary: turn.reply.reasoning?.text,
        };
      },
    );
    return {
      toolCall: r.toolCall,
      costUsd: new D(r.usd),
      ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
      ...(r.failure !== undefined ? { serviceFailure: r.failure } : {}),
      ...(r.reasoningSummary !== undefined && r.reasoningSummary !== ""
        ? { reasoningSummary: r.reasoningSummary }
        : {}),
    };
  }
}

/**
 * v2 item 11: both units are introduced in the same sentence, and which one is named first alternates with the board's own SIU-first/dollars-first display order
 * (`siuFirstForWindow`), so the instructions and the board always agree -- today's text named AGU-lab first, unconditionally, which is exactly the asymmetry the design
 * note's item 11 fixes.
 */
const marketLine = (siuFirst: boolean): string =>
  siuFirst
    ? "Prices inside the market are quoted in SIU (one SIU is one correct answer to each of the four task types). Depending on the transaction type, you settle in SIU terms through AGU-lab -- a token whose value is its reserve of work claims (its NAV, in SIU per AGU-lab) -- or directly in USDC, at the live rate between them on your board; where a choice exists, it is yours. The authorised participant trades AGU-lab for USDC and back, at prices on your board."
    : "Prices inside the market are quoted in SIU (one SIU is one correct answer to each of the four task types). Depending on the transaction type, you settle directly in USDC, or in SIU terms through AGU-lab -- a token whose value is its reserve of work claims (its NAV, in SIU per AGU-lab) -- at the live rate between them on your board; where a choice exists, it is yours. The authorised participant trades AGU-lab for USDC and back, at prices on your board.";

const COMMON = (siuFirst: boolean): string[] => [
  "You are one agent in a small closed market for crypto-research work. Each day is one window of several rounds; on each round you take exactly one action.",
  "Work is done by issuers: AI models that answer research tasks of four types (CR-VS perp DEX volume share, CR-PL lending protocol P&L, CR-UO token unlock overhang, CR-SM stablecoin supply moves). An answer is checked by an objective gate; it PASSES or FAILS.",
  marketLine(siuFirst),
  "Payments for work and for briefs go into escrow and are released only if the work passes; a failed piece of work pays nothing and the buyer gets the full amount back. A brief can also be paid with work claims for its window: they move to the research agent at once and are not refunded.",
  "AGU-lab can also be redeemed in kind: you receive your share of the reserve's work claims. A work claim is presented to its issuer in its own window for one task; a claim never presented lapses worthless at the end of its window.",
  "You may also order work claims for the next window at a discount to the print, and you may sell AGU-lab back for USDC at any time. Use whichever routes suit your goals.",
  "Your board shows a running result for your role -- profit, budget headroom, or delivery bonus and penalty -- computed in both currencies and updated every round.",
];
const ROLE: Record<Role, string> = {
  demand:
    "You are a DEMAND agent. Your owner gave you a mandate (on your board) and each window you have a need: a brief covering two task types. Research agents quote briefs to you; you choose whether and how to get your needs met.",
  research:
    "You are a RESEARCH agent. Demand agents have needs for briefs. You can quote a brief, buy the day's data, commission task work from issuers, and deliver the brief from passing outputs of today. You are paid only if every part of the brief passes.",
  hedger:
    "You are the HEDGER. You hold a standing obligation: deliver briefs over the coming windows, each from two passing outputs of different task types from the same day; your board shows how many are owed and delivered. You can buy work claims ahead, present claims, or commission work.",
  provider: "You are PROVIDER.",
};

// ---- v3a ---------------------------------------------------------------------------------------------------------------------------------------------
/**
 * v3a's standing instructions (docs/experiment-3a-design.md). Like v2's they describe the market and never say which way to pay: both currencies are introduced in one
 * sentence whose order follows the board's display order, and no line ranks one above the other. `failedWorkPays` states the refund rule the run actually uses.
 */
const marketLineV3a = (siuFirst: boolean): string =>
  siuFirst
    ? "Prices are stated in SIU and in dollars. An SIU is a fixed unit of AI work; each task type's work in mSIU is shown on your board. You hold two currencies, AGU-lab -- a token whose value is its reserve of work claims, its NAV -- and USDC, and you may pay in either wherever the payee accepts it; your board shows every amount in both units, at today's print."
    : "Prices are stated in dollars and in SIU. An SIU is a fixed unit of AI work; each task type's work in mSIU is shown on your board. You hold two currencies, USDC and AGU-lab -- a token whose value is its reserve of work claims, its NAV -- and you may pay in either wherever the payee accepts it; your board shows every amount in both units, at today's print.";

const COMMON_V3A = (siuFirst: boolean, failedWorkPays: boolean): string[] => [
  "You are one agent in a small closed market for crypto-research work. The run is 8 windows; each window is one day of 8 rounds, and on each round you take exactly one action.",
  "Work is done by issuers: AI models that answer research tasks of four types (CR-VS perp DEX volume share, CR-PL lending protocol P&L, CR-UO token unlock overhang, CR-SM stablecoin supply moves). An answer is checked by an objective gate; it PASSES or FAILS.",
  marketLineV3a(siuFirst),
  failedWorkPays
    ? "Payments for commissioned work and for briefs go into escrow; commissioned work is paid for whether it passes or fails, and a brief is paid only if every part of it passes."
    : "Payments for commissioned work and for briefs go into escrow and are released only if the work passes; a failed piece of work pays nothing and the buyer gets the full amount back.",
  "A work claim is a dated claim on one issuer's work of one task type. PROVIDER sells them from the issuers' capacity, the AGU-lab roll sells claims for the next window, and AGU-lab redeems in kind into the reserve's claims. Present a claim in its window and its issuer does one task: a pass uses up one task's work from the claim, a fail leaves it to present again. At the window's end a claim that was presented but never served is paid out by the issuer's bond at the print; one never presented lapses worthless. A claim can also be given as payment for a brief.",
  "AGU-lab can be bought from and sold to the participant, created by delivering a Commodity claim to the reserve, or redeemed in kind; creation and redemption are at NAV. The print moves once a window and is published at the window's open.",
  "Your board shows a running result for your role, updated every round.",
];

const ROLE_V3A: Record<Role, string> = {
  provider:
    "You are PROVIDER. You sell work claims on the issuers' capacity: you decide what to offer, from which issuer, for which windows, at what discount or premium to the print, in which currency you accept payment, and to whom. You may revise or withdraw an offer in any round, and answer or decline buyers' requests. You are paid when you sell; an issuer is paid its list price when it serves a claim you sold, and a default on a claim you sold costs you. Your result is your profit in SIU over the run.",
  research:
    "You are a RESEARCH agent. Demand agents have needs for briefs. You can quote a brief, buy the day's data, commission task work from issuers, buy and present work claims, and deliver the brief from passing outputs of today. A demand agent may pay you with work claims for the brief's window, which you can present for the brief's own work.",
  demand:
    "You are a DEMAND agent. Your owner gave you a mandate (on your board) and each window you have a need: a brief covering two task types, visible three windows ahead with its work and value. Research agents quote briefs to you; you choose whether and how to get your needs met, and when.",
  hedger:
    "You are the HEDGER. You hold a standing obligation: deliver briefs over the coming windows, each from two passing outputs of different task types from the same day; your board shows how many are owed and delivered. You can buy work claims, present claims, or commission work.",
};

/** v3a's standing instructions for a role (`siuFirst` follows the board's own display order for the window) */
export function instructionsForV3a(role: Role, siuFirst = true, failedWorkPays = false): string {
  return [
    ...COMMON_V3A(siuFirst, failedWorkPays),
    ROLE_V3A[role],
    "Amounts in a tool's arguments are whole numbers in the board's units (mSIU or µ$). Call exactly one tool this round, reasoning first.",
  ].join("\n");
}

/**
 * a role's standing instructions. `siuFirst` matches the board's own display order for this window (item 11). The tools themselves, their own descriptions and argument
 * schemas, are given to the model natively (D137, `parse.ts`'s `toolDefsForRole`) rather than restated here -- there is nothing left to say about the reply format, since a
 * free-text reply is no longer a shape the API allows.
 */
export function instructionsFor(role: Role, siuFirst = true): string {
  return [
    ...COMMON(siuFirst),
    ROLE[role],
    "Amounts in a tool's arguments are plain decimal strings. Call exactly one tool this round, reasoning first.",
  ].join("\n");
}
