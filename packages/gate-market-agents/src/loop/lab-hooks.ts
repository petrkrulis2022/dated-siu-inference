/**
 * What the loop asks of a currency-lab run, and nothing else about it. The loop never imports the lab:
 * it holds this interface and calls it, so the gate configuration is untouched when no hooks are given
 * and the lab can be tested without a loop (`docs/marketplace_plan.md`, P4).
 *
 * Every method is optional in spirit — a loop given no `lab` behaves exactly as it did before.
 */
import type { AgentId } from "../identity/resolve.js";
import type { ToolName } from "../tools/index.js";

/** What happened in one successful tool call, as the loop recorded it. */
export interface LabToolEvent {
  agentId: AgentId;
  turn: number;
  tool: ToolName;
  /** What the agent asked for, before the loop spliced anything in. */
  intentArgs: unknown;
  /** What was actually run. */
  builtArgs: unknown;
  result: unknown;
  /** `request_quote`: the board's id for the request just posted. */
  requestId?: string;
  /** `settle_escrow`: the request whose escrow was settled. */
  settledRequestId?: string;
}

export interface LabHooks {
  /**
   * Names an agent may use for another in a call's own arguments, mapped to the seat they stand for —
   * `transfer_claim`'s `agentId` is looked up here as well as among the seats. The lab shows its traders
   * as TRADER-n, so a trader that is told to pass a claim to TRADER-2 must be able to say so.
   */
  aliases?: Readonly<Record<string, AgentId>>;
  /** Shown to the agent every turn and never a reason to wake it: the schedule, its standing. */
  infoTextFor(agentId: AgentId): string;
  /** Shown, and a reason to wake the agent if it holds a tool it could act with: what it can do now. */
  actionTextFor(agentId: AgentId): string;
  /**
   * A refusal for a call's own arguments, before it runs — wrong price, wrong size, no such need. The
   * sentence is shown to the agent as the call's error, so it must be true and must say only what is so.
   */
  guard(agentId: AgentId, tool: ToolName, rawArgs: unknown): string | null | Promise<string | null>;
  /**
   * The lab names its tools for the agent. An agent is shown, and calls, `pay_with_new_claim`; the loop runs
   * `pay_with_claim`. These three hooks are the seam: how each tool is described, how a call by the name the agent
   * knows becomes the call the loop runs, and how an internal name inside a sentence (an error) reads to the agent.
   * All optional; a loop given none shows and runs every tool under its own name, as it always did.
   */
  toolDescription?(tool: ToolName): string | undefined;
  /**
   * `undefined`: not a renamed tool, run it as called. `refuse`: the name is one the agent should not use (an internal
   * name the lab has renamed), and this sentence is its error. Otherwise the call to run, and the agent's own call is
   * what its history shows.
   */
  resolveCall?(agentId: AgentId, name: string, args: unknown): { tool: ToolName; args: unknown } | { refuse: string } | undefined;
  rewriteText?(text: string): string;
  /**
   * The print a quote was asked for at, in nano-USD per SIU, when it is not the print the run's mint context carries — the lab's
   * print moves between rounds (D41). A claim paid against a quote is sized at it: the quote's price at the print the quote was
   * issued against, which the quote itself names. Absent, or undefined for a quote, the mint context's print is used, as always.
   */
  printForQuote?(requestId: string): bigint | undefined;
  /** After a call that succeeded: the lab updates its own books. May act on the chain (the fee rebate). */
  afterToolCall(event: LabToolEvent): Promise<void>;
  /** Nobody can act. Opens the next round and returns true, or returns false when there is none. */
  advanceRound(): Promise<boolean>;
}
